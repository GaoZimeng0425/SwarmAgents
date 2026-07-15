# Agent 执行链路:emit 注入 vs 传送带(async generator)

> 背景:现在从 renderer 输入到 agent 运行的链路,感觉"绕、参数包越滚越大"。
> 这份笔记解释病根在哪,以及两种把事件透出核心的模式到底差在哪。
> 结论先行:**两种都能工作,功能可以等价;真正的区别不在运行时,在代码的依赖结构。**

---

## 0. 先看清一个基本问题

一个 agent 跑一次,函数**还没结束**时就会陆续发生很多事:

```
开始了 → 模型说了句话 → 调了个工具 → 工具返回了 → 完成了
```

普通函数做不到把"中途事件"透出去——它只有跑完 `return` 一个结果,中间的事外面看不见:

```js
function normal() {
  console.log("A"); console.log("B"); console.log("C")
  return "done"
}
const r = normal()   // 一口气跑完 A B C,外面只拿到 "done",中途插不进手
```

要把中途事件透给 UI / 数据库,业界只有两类手段:

- **手段 A —— 塞一个「对讲机」emit 进去**(推 / push):函数主动喊,外面被动听。
- **手段 B —— 函数变「传送带」**(拉 / pull):函数把事件放上带子、停住,外面主动取。

---

## 1. 手段 A:对讲机 emit(SwarmAgents 现在的模式)

外面造一个 `emit`,塞进函数。函数每发生一件事就对着 emit 喊一声,喊完继续跑。

```js
// 外面:造对讲机,决定"听到了怎么办"
function emit(event) {
  store(event)         // 存数据库
  broadcast(event)     // 发给 UI
}

// 把对讲机塞进去
runAgent(input, emit)

// 函数内部:发生事情就喊
function runAgent(input, emit) {
  emit("created")
  emit("message")
  emit("complete")
  return result
}
```

要点:**函数拿着别人给的对讲机,主动喊;喊出去就不管了。** 主动权在函数(喊的一方)。

### 现状里的真实形态

```ts
// apps/desktop/src/service/message-engine/emit.ts
export type MessageEmit = (input: MessageEmitInput) => void   // 注意:返回 void
```

返回值是 `void` —— **发完即忘,根本不等外面处理完**(没有背压)。

---

## 2. 手段 B:传送带 async generator

函数不喊了。它变成传送带:做完一件,放上带子,**自己停住**,等外面取走后才继续做下一件。

```js
function* belt() {          // ← function 后面的星号 = 传送带函数
  console.log("里面:A")
  yield 1                   // 放 1 上带子,然后【停住】
  console.log("里面:B")
  yield 2                   // 外面取走后才会执行到这;放 2,再【停住】
  console.log("里面:C")
}
```

### 2.1 最反直觉的一点:调用它不执行任何代码

```js
const b = belt()   // 什么都不打印!只是拿到传送带把手,一行都没跑
```

### 2.2 谁来"取",里面才动一步(手动版)

```js
const b = belt()

console.log("外面:准备取第1个")
const first = b.next()                 // ← 此刻里面才开始跑
//   里面:打印 "里面:A" → 遇到 yield 1 →【停住】→ 交出 1
console.log("外面拿到:", first.value)   // 1

console.log("外面:准备取第2个")
const second = b.next()                // ← 叫醒里面,从上次停住处继续
//   里面:打印 "里面:B" → yield 2 →【停住】→ 交出 2
console.log("外面拿到:", second.value)  // 2

b.next()                               // ← 再叫醒:打印 "里面:C",结束
```

实际打印顺序(全部的"魔法"就在这):

```
外面:准备取第1个
里面:A              ← 取的时候里面才跑到这
外面拿到: 1
外面:准备取第2个
里面:B              ← 第二次取,里面从 B 继续
外面拿到: 2
里面:C
```

**外面和里面在交替执行,像打乒乓球。** 里面跑到 `yield` 就停下把球打给外面,外面处理完再打回去,里面从**原地**继续。控制权在两边来回传。

### 2.3 `for await ... of` = 自动帮你不停地取

```js
for await (const x of belt()) {
  console.log("处理:", x)   // 每取到一个,循环体跑一遍;带子空了自动停
}
// 里面:A / 处理: 1 / 里面:B / 处理: 2 / 里面:C
```

(`await` 版是因为 agent 每步要等网络:`async function*` + `for await`,机制完全一样,只是每步中间能等 IO。)

---

## 3. 核心疑问:emit 返回 Promise 并 await,不就和传送带一样了吗?

**对,你的直觉是对的。** 就"能不能等外面处理完再继续"这件事,两者可以做到等价:

```ts
// 会等待的 emit 版
async function runAgent(input, emit) {
  await emit({ kind: "created" })   // 等外面处理完,再继续
  await emit({ kind: "message" })
}

// 传送带版
async function* runAgent(input) {
  yield { kind: "created" }         // 停住,等外面取走+处理完,再继续
  yield { kind: "message" }
}
```

**这两段运行时行为几乎一模一样。** 所以真正的区别**不在功能、不在运行时**,而在下面这件事。

---

## 4. 真正的区别:句柄要传几层,核心依赖谁

### 4.1 emit 版:句柄穿透 4 层函数签名

SwarmAgents 真实链路,`emit` 这个句柄被逐层往下塞:

```ts
// 第1层 submitPrompt:造出 emit
const emit = createMessageEmit(emitPorts, {...})
launchMessage(spec, { emit, ... })                    // 塞进 ports 传下去

// 第2层 launchMessage:接住,再往下塞
const emit = createMessageEmit(ports.emit, {...})
createEngine({ emit, ... })                           // 又传下去

// 第3层 createEngine:接住
const translator = createMessageTranslator(deps.emit) // 交给 translator

// 第4层 translator:终于用上 emit
```

`emit` 穿透了 **4 层函数**。每层的参数包(`MessageSpec` 26 字段、`EngineDeps` 21 字段、`LaunchPorts`…)都得带着它、外加 abort 句柄、permission 句柄一起往下递。

> **这就是"链路绕、参数包越滚越大"的机制性病根** —— 不是谁写得烂,
> 是"注入句柄"这个模式**逼着**你逐层传递。

### 4.2 传送带版:句柄消失

```ts
// 第3层 engine:只管产出,不接收任何 emit
async function* runEngine(input) {
  yield { kind: "created" }
  yield { kind: "message" }
}

// 第2层 launchMessage:直接把传送带转发出去
function launch(input) {
  return runEngine(input)          // 或 for await 转发,顺便加自己的事件
}

// 第1层 submitPrompt:站在传送带尾巴,想干嘛干嘛
for await (const evt of launch(input)) {
  store.append(stamp(evt))         // 存库
  broadcaster.broadcast(evt)       // 广播
}
```

`emit` 句柄**彻底消失**。没有任何一层需要"接收 emit 并往下传"。核心 `runEngine` 签名干净:输入进、事件出,**不依赖任何外部句柄**。存库/广播/加序号全部收拢到最外层那一个 `for await` 循环里。

---

## 5. 对比总表

| 维度 | emit 注入(现在) | 传送带 async generator(建议) |
|---|---|---|
| 运行时行为 | 可做到等价 | 可做到等价 |
| 核心依赖谁 | **依赖**外部塞进来的 emit / abort / permission 句柄 | **谁都不依赖**,输入 → 事件流 |
| 句柄怎么走 | 穿透 4 层函数签名,逐层传递 | 不存在,最外层一个循环搞定 |
| 谁调用谁 | 核心 → 回调外部(控制反转) | 外部 → 拉取核心(方向理顺) |
| "会发出什么" | 读完函数体才知道 | 看返回类型 `AsyncIterable<Event>` 就知道 |
| 可测试性 | 要造收集型 mock emit | 收集迭代结果比对即可,可重放 |
| 背压 | 现状 `void` 无背压;改 `Promise` 才有 | 天生有 |
| 中间层成本 | 传一个 emit 参数即可 | 想加事件要写 `for await (...) { yield ... }` 转发,略啰嗦 |

---

## 6. 反向控制(取消 / 权限批准)两种模式一样

有个常见误解:"传送带是单向的,所以做不了权限弹窗"。**不成立。**

- 传送带只管**事件往外流**;
- "取消运行""等用户点批准"这种**外面要影响里面**的事,两种模式**都是**另塞一个东西进去:
  一个 `signal`(取消信号)、一个 `requestPermission`(阻塞等用户决定的函数)。

这部分 A 和 B 没区别,都得注入。**所以它不影响你选 A 还是 B。**

---

## 7. 主流实现怎么选(佐证)

没人用纯粹的某一种,主流收敛在"**出方向用异步流/队列(拉),进方向用注入回调/通道**":

- **Claude Code / Claude Agent SDK**:`query()` 返回 **AsyncGenerator**(`for await` 消费),
  generator 上挂 `interrupt()` / `setPermissionMode()` 等控制方法;
  权限批准走 options 注入的 **`canUseTool` 回调**(必须阻塞等答案,事件流做不到)。
- **Codex (codex-rs)**:**SQ/EQ 提交队列 + 事件队列** 双通道,`submit(op)` 进、`next_event()` 出;
  审批作为一种 op 走同一条 duplex 协议回去。
- **OpenAI Agents SDK**:`run_streamed()` 返回句柄,`.stream_events()` 异步迭代 + 最终结果 Promise。
- **Vercel AI SDK**:`streamText()` 返回句柄,`fullStream`(AsyncIterable)+ 若干结果 Promise。

共同规律:**产出(事件)让消费者拉;反向交互(取消、批准)用注入,因为它们必须能阻塞核心循环。**
纯 emit 一般只出现在内部实现层,不作为对外 API —— 因为它把"产出什么"藏进了实现。

---

## 8. SwarmAgents 当前定位

- 最底层 pi 的 `Agent` 是**句柄对象**:`agent.subscribe()` / `agent.prompt()` / `agent.abort()`。
- `engine.ts` 把它**翻译成 emit**:`agent.subscribe(e => translator.handle(e))` → `deps.emit(...)`。
- `launchMessage` / `submitPrompt` 继续用 emit,一路推到顶;端口内部扇出(存库 + 标记终态 + 广播)。
- renderer 从不消费返回值流:`submitPrompt` 立刻返回 `{ messageId }`,UI 全靠 broadcaster 推送、按 seq 重放。

一句话:**③ 埋在最底层,② 一路推到顶,事件与调用返回值完全解耦。**
这也是每层都要接力传 emit / abort / permission、参数包越滚越大的原因。

---

## 9. 一句话结论

> 选传送带**不是因为 emit 不能用**(它能,而且能等价工作),
> 而是因为这次的目标是"要一个干净的最小执行核心、把绕来绕去的链路理直"。
> emit 模式下核心永远攥着别人的句柄、句柄永远逐层穿透;
> 传送带模式下核心零依赖、句柄消失。**它正好解决你说的那个"绕"。**
