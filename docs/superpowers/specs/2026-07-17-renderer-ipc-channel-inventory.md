# Renderer↔Main IPC Channel Inventory

Date: 2026-07-17
Status: authoritative reference for `2026-07-17-renderer-ipc-single-source-design.md` (Plans 1-3)

Produced by running, from the worktree root:

```bash
grep -rn "ipcMain.handle(" apps/desktop/src/main --include='*.ts' | grep -v '\.test\.' > /tmp/handles.txt   # 139 lines
grep -n "ipcRenderer.invoke(" apps/desktop/src/preload/index.ts > /tmp/invokes.txt                          # 150 lines
grep -n "ipcRenderer.on(" apps/desktop/src/preload/index.ts > /tmp/subs.txt                                 # 14 lines
grep -rn "webContents.send(" apps/desktop/src/main --include='*.ts' | grep -v '\.test\.' > /tmp/sends.txt   # 15 lines
grep -rn "_CHANNEL = '\|_CHANNEL_ = '\|CHANNEL: '\|= 'swarm:\|= 'system:" apps/desktop/src/main apps/desktop/src/preload --include='*.ts' | grep -v '\.test\.' > /tmp/consts.txt  # 22 lines
```

Every row below cites a real `file:line` opened and read directly (no guessed strings). The
**Reconciliation** section (bottom) proves all 139+150+14+15 = 318 raw grep hits are accounted
for — either as a 1:1 table row or as an explicitly documented fan-out/collapse.

Tables cover **invoke/handle (request-response) channels only**, one row per distinct channel
string, columns `channel | handler file:line | preload member | notes`. All **event channels**
(`webContents.send` / `ipcRenderer.on`) are listed together in the Reconciliation section with
their payload types, per the task brief.

---

## swarm-ipc (33 channels — `apps/desktop/src/main/ipc/swarm-ipc.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `skills:list` | swarm-ipc.ts:94 | `skills.list` | preload/index.ts:225 |
| `skills:save` | swarm-ipc.ts:96 | `skills.save` | preload:226 |
| `skills:delete` | swarm-ipc.ts:99 | `skills.remove` | preload:227 — preload method name (`remove`) ≠ channel suffix (`delete`) |
| `skills:import` | swarm-ipc.ts:105 (channel string at :106, multi-line handler body 105-126) | `skills.importFolder` | preload:228-229 — handler opens a native folder dialog when no `sourceDir` arg is given; result can be `{ok:false, code:'cancelled'}` or echo `sourceDir` on a name clash |
| `agents:list` | swarm-ipc.ts:95 | `agents.list` | preload:247 |
| `agents:save` | swarm-ipc.ts:100 (body wraps to :102) | `agents.save` | preload:248 |
| `agents:delete` | swarm-ipc.ts:103 | `agents.remove` | preload:249 — name mismatch like skills:delete |
| `agents:restore-defaults` | swarm-ipc.ts:104 | `agents.restoreDefaults` | preload:250 |
| `memory:list` | swarm-ipc.ts:127 (body at :127-129) | `memory.list` | preload:242-243 |
| `toolToggles:get` | swarm-ipc.ts:132 | `toolToggles.get` | preload:233 |
| `toolToggles:setSkill` | swarm-ipc.ts:133 (body wraps to :135) | `toolToggles.setSkillEnabled` | preload:235-236 |
| `toolToggles:setToolGroup` | swarm-ipc.ts:136 (body wraps to :138) | `toolToggles.setToolGroupEnabled` | preload:237-238 |
| `tools:listGroups` | swarm-ipc.ts:139 | `toolToggles.listGroups` | preload:234 — lives on the `toolToggles` bridge despite the `tools:` channel prefix |
| `swarm:createSession` | swarm-ipc.ts:235 | `swarm.sessions.create` | preload:359 |
| `swarm:forkSession` | swarm-ipc.ts:236 (body wraps to :238) | `swarm.forkSession` | preload:355-356 |
| `swarm:analyzeThread` | swarm-ipc.ts:239 | `swarm.analyzeThread` | preload:350-351 |
| `swarm:listSessions` | swarm-ipc.ts:240 | `swarm.sessions.list` | preload:358 |
| `swarm:getSessionEntries` | swarm-ipc.ts:241 | `swarm.sessions.getSessionEntries` | preload:360-363 |
| `swarm:getUsageStats` | swarm-ipc.ts:242 | `swarm.usage.get` | preload:374-375 |
| `swarm:deleteSession` | swarm-ipc.ts:243 | `swarm.sessions.delete` | preload:364 |
| `swarm:renameSession` | swarm-ipc.ts:244 | `swarm.sessions.rename` | preload:365-366 |
| `swarm:setSessionPinned` | swarm-ipc.ts:245 | `swarm.sessions.setPinned` | preload:367-368 |
| `swarm:updateSessionSettings` | swarm-ipc.ts:246 | `swarm.sessions.updateSettings` | preload:369-370 |
| `swarm:reorderSessions` | swarm-ipc.ts:247 | `swarm.sessions.reorder` | preload:371 |
| `swarm:submitPrompt` | swarm-ipc.ts:248 | `swarm.submitPrompt` | preload:348-349 |
| `swarm:cancelRun` | swarm-ipc.ts:249 | `swarm.cancelRun` | preload:352 |
| `swarm:decidePermission` | swarm-ipc.ts:250 | `swarm.decidePermission` | preload:353-354 |
| `swarm:listCronJobsForSession` | swarm-ipc.ts:251 | `swarm.cron.listForSession` | preload:390-391 |
| `swarm:listAllCronJobs` | swarm-ipc.ts:252 | `swarm.cron.listAll` | preload:394 |
| `swarm:listAllCronRuns` | swarm-ipc.ts:253 | `swarm.cron.listAllRuns` | preload:395 |
| `swarm:cancelCronJob` | swarm-ipc.ts:254 | `swarm.cron.cancel` | preload:396 |
| `swarm:exportSessionMarkdown` | swarm-ipc.ts:257 (body wraps to :259) | `swarm.exportSessionMarkdown` | preload:409-410 |
| `swarm:listArtifacts` | swarm-ipc.ts:261 (body wraps to :263) | `swarm.listArtifacts` | preload:411-412 — handler is registered only `if (cmdPalette)` (swarm-ipc.ts:260); `main/index.ts:169-180` always constructs and passes `cmdPalette`, so in practice it's always registered, but the conditional is real |

## system (10 channels)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `system:getAccent` | swarm-ipc.ts:267 | `swarm.getAccent` | preload:437 |
| `system:readImageFile` | swarm-ipc.ts:292 | `swarm.readImageFile` | preload:453-454 |
| `system:readDocumentFile` | swarm-ipc.ts:310 | `swarm.readDocumentFile` | preload:455-456 |
| `system:openPath` | swarm-ipc.ts:317 | `swarm.openPath` | preload:457 |
| `system:openUserDataDir` | swarm-ipc.ts:326 | `swarm.openUserDataDir` | preload:458 |
| `system:pickPath` | swarm-ipc.ts:340 | `swarm.pickDirectory` **and** `swarm.pickFile` | preload:459 (`pickDirectory` invokes with literal `'directory'`), preload:460 (`pickFile` invokes with literal `'file'`) — **one channel, one handler, two preload members** distinguished only by the 2nd invoke argument |
| `system:listDir` | swarm-ipc.ts:363 | `swarm.listDir` | preload:461-462 |
| `system:getMacPermissions` | swarm-ipc.ts:365 | `swarm.getMacPermissions` | preload:445 |
| `system:openPrivacySettings` | swarm-ipc.ts:368 | `swarm.openPrivacySettings` | preload:446 |
| `system:getWsHostConfig` | main/index.ts:186 | `swarm.getWsHostConfig` | preload:447-452 — only main-process handler NOT in one of the 15 domain `ipc.ts` files; inlined in `index.ts` because it closes over the `wsHost` variable set at index.ts:157 |

## article (4 channels — `apps/desktop/src/main/ipc/article-ipc.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `swarm:article:list` | article-ipc.ts:27 | `swarm.article.list` | preload:399 |
| `swarm:article:analyze` | article-ipc.ts:28 | `swarm.article.analyze` | preload:400-401 — handler host-injects the active provider (article-ipc.ts:17-25); returns `{ok:false, code:'no_provider'}` if none configured |
| `swarm:article:getAnalysis` | article-ipc.ts:29 | `swarm.article.getAnalysis` | preload:402-406 |
| `swarm:article:delete` | article-ipc.ts:30 | `swarm.article.delete` | preload:407 |

## trending (4 channels — `apps/desktop/src/main/trending/ipc.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `trending:get` | trending/ipc.ts:22 | `swarm.trending.get` | preload:378-379 — dependency-free, no `serviceClient` needed |
| `trending:research` | trending/ipc.ts:65 | `swarm.trending.research` | preload:380-381 — separate `wireTrendingResearchIpc` wiring (needs `serviceClient`+`providers`); host-injects the active provider (trending/ipc.ts:55-58) |
| `trending:getResearch` | trending/ipc.ts:66 | `swarm.trending.getResearch` | preload:382-386 |
| `trending:researchedNames` | trending/ipc.ts:67 | `swarm.trending.researchedNames` | preload:387 |

## quick-panel (4 channels — `apps/desktop/src/main/quick-panel/ipc.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `swarm:quickPanel:hide` | quick-panel/ipc.ts:23 | `swarm.quickPanel.hide` | preload:477 |
| `swarm:quickPanel:focusMain` | quick-panel/ipc.ts:27 | `swarm.quickPanel.focusMain` | preload:478-479 — handler also **sends** the `swarm:navigate` event (quick-panel/ipc.ts:42, see Events) and can call `openSettings()` directly (line 46) as a side effect, not just an invoke passthrough |
| `swarm:quickPanel:getHotkey` | quick-panel/ipc.ts:51 | `swarm.quickPanel.getHotkey` | preload:480 — **Task 2 hotkey channel** |
| `swarm:quickPanel:setHotkey` | quick-panel/ipc.ts:55 | `swarm.quickPanel.setHotkey` | preload:481-482 — **Task 2 hotkey channel** |

## deep-link (1 channel — `apps/desktop/src/main/system/deep-link.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `swarm:consumePendingDeepLink` | deep-link.ts:69 | `swarm.consumePendingDeepLink` | preload:435-436 — one-shot pull for a chat deep link that arrived before the renderer subscribed; deep-link.ts also **sends** `swarm:navigate` for links arriving live (see Events) |

## bilibili (24 channels — `apps/desktop/src/main/bilibili/ipc.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `bilibili:status` | bilibili/ipc.ts:158 | `bilibili.status` | preload:254 |
| `bilibili:login` | bilibili/ipc.ts:163 | `bilibili.login` | preload:255 |
| `bilibili:logout` | bilibili/ipc.ts:164 | `bilibili.logout` | preload:256 |
| `bilibili:list` | bilibili/ipc.ts:165 | `bilibili.list` | preload:257 |
| `bilibili:process` | bilibili/ipc.ts:219 | `bilibili.process` | preload:258 |
| `bilibili:open` | bilibili/ipc.ts:249 | `bilibili.open` | preload:259 |
| `bilibili:getObsidianConfig` | bilibili/ipc.ts:251 | `bilibili.getObsidianConfig` | preload:260 |
| `bilibili:setObsidianConfig` | bilibili/ipc.ts:255 | `bilibili.setObsidianConfig` | preload:261 |
| `bilibili:pickVault` | bilibili/ipc.ts:261 | `bilibili.pickVault` | preload:262 |
| `bilibili:save` | bilibili/ipc.ts:266 | `bilibili.save` | preload:263-264 |
| `bilibili:getTranscribeConfig` | bilibili/ipc.ts:271 | `bilibili.getTranscribeConfig` | preload:265 |
| `bilibili:setTranscribeConfig` | bilibili/ipc.ts:275 | `bilibili.setTranscribeConfig` | preload:266-267 |
| `bilibili:pickModelDir` | bilibili/ipc.ts:284 | `bilibili.pickModelDir` | preload:268 |
| `bilibili:transcribe` | bilibili/ipc.ts:289 | `bilibili.transcribe` | preload:269 |
| `bilibili:analyzedBvids` | bilibili/ipc.ts:305 | `bilibili.analyzedBvids` | preload:277 |
| `bilibili:getAnalysis` | bilibili/ipc.ts:307 | `bilibili.getAnalysis` | preload:278 |
| `bilibili:deleteWatchLater` | bilibili/ipc.ts:312 | `bilibili.deleteWatchLater` | preload:279-280 |
| `bilibili:deleteFav` | bilibili/ipc.ts:331 | `bilibili.deleteFav` | preload:281 |
| `bilibili:archiveList` | bilibili/ipc.ts:354 | `bilibili.archiveList` | preload:282 |
| `bilibili:archivePut` | bilibili/ipc.ts:355 | `bilibili.archivePut` | preload:283 |
| `bilibili:archiveRemove` | bilibili/ipc.ts:359 | `bilibili.archiveRemove` | preload:284 |
| `bilibili:pinsList` | bilibili/ipc.ts:365 | `bilibili.pinsList` | preload:285 |
| `bilibili:pinsPut` | bilibili/ipc.ts:366 | `bilibili.pinsPut` | preload:286 |
| `bilibili:pinsRemove` | bilibili/ipc.ts:370 | `bilibili.pinsRemove` | preload:287 |

## providers (17 channels — `apps/desktop/src/main/providers/ipc.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `providers:get` | providers/ipc.ts:78 | `providers.get` | preload:95 |
| `providers:setKey` | providers/ipc.ts:80 | `providers.setKey` | preload:96 |
| `providers:clearKey` | providers/ipc.ts:87 | `providers.clearKey` | preload:97 |
| `providers:setActive` | providers/ipc.ts:92 | `providers.setActive` | preload:98 |
| `providers:setModel` | providers/ipc.ts:98 | `providers.setModel` | preload:99-100 |
| `providers:addCustomModel` | providers/ipc.ts:108 | `providers.addCustomModel` | preload:103-104 |
| `providers:removeCustomModel` | providers/ipc.ts:117 | `providers.removeCustomModel` | preload:105-106 |
| `providers:setApiStyle` | providers/ipc.ts:124 | `providers.setApiStyle` | preload:107-108 |
| `providers:setThinkingLevel` | providers/ipc.ts:132 | `providers.setThinkingLevel` | preload:109-110 |
| `providers:setFallbackProviderIds` | providers/ipc.ts:140 | `providers.setFallbackProviderIds` | preload:111-112 |
| `providers:setModelContextWindow` | providers/ipc.ts:148 (multi-line call, channel string at :149) | `providers.setModelContextWindow` | preload:113-114 |
| `providers:fetchModelInfo` | providers/ipc.ts:160 | `providers.fetchModelInfo` | preload:115-116 |
| `providers:setBaseUrl` | providers/ipc.ts:197 | `providers.setBaseUrl` | preload:101-102 |
| `providers:addCustomProvider` | providers/ipc.ts:205 | `providers.addCustomProvider` | preload:117-118 |
| `providers:removeCustomProvider` | providers/ipc.ts:226 | `providers.removeCustomProvider` | preload:119-120 |
| `providers:renameCustomProvider` | providers/ipc.ts:231 | `providers.renameCustomProvider` | preload:121-122 |
| `providers:test` | providers/ipc.ts:238 | `providers.test` | preload:123 |

## gmail (14 channels — `apps/desktop/src/main/gmail/ipc.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `gmail:getStatus` | gmail/ipc.ts:33 | `gmail.getStatus` | preload:291 |
| `gmail:setClientCreds` | gmail/ipc.ts:34 | `gmail.setClientCreds` | preload:292-293 |
| `gmail:clearClientCreds` | gmail/ipc.ts:35 | `gmail.clearClientCreds` | preload:294 |
| `gmail:linkAccount` | gmail/ipc.ts:36 | `gmail.linkAccount` | preload:295 |
| `gmail:unlinkAccount` | gmail/ipc.ts:37 | `gmail.unlinkAccount` | preload:296 |
| `gmail:syncNow` | gmail/ipc.ts:38 | `gmail.syncNow` | preload:297 |
| `gmail:listRecent` | gmail/ipc.ts:41 (body wraps to :43) | `gmail.listRecent` | preload:298-299 |
| `gmail:getThread` | gmail/ipc.ts:44 | `gmail.getThread` | preload:300-304 |
| `gmail:search` | gmail/ipc.ts:45 | `gmail.search` | preload:305 |
| `gmail:getThreadAnalysis` | gmail/ipc.ts:46 | `gmail.getThreadAnalysis` | preload:306-307 |
| `gmail:saveThreadAnalysis` | gmail/ipc.ts:47 (multi-line call, channel string at :48) | `gmail.saveThreadAnalysis` | preload:308-309 |
| `gmail:analyzedThreadIds` | gmail/ipc.ts:52 | `gmail.analyzedThreadIds` | preload:310 |
| `gmail:markThreadRead` | gmail/ipc.ts:53 | `gmail.markThreadRead` | preload:311 |
| `gmail:listInboxPage` | gmail/ipc.ts:54 | `gmail.listInboxPage` | preload:312-313 |

## calendar (10 channels — `apps/desktop/src/main/calendar/ipc.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `calendar:getStatus` | calendar/ipc.ts:34 | `calendar.getStatus` | preload:324 |
| `calendar:setClientCreds` | calendar/ipc.ts:35 | `calendar.setClientCreds` | preload:325-326 |
| `calendar:clearClientCreds` | calendar/ipc.ts:36 | `calendar.clearClientCreds` | preload:327 |
| `calendar:linkAccount` | calendar/ipc.ts:37 | `calendar.linkAccount` | preload:328 |
| `calendar:unlinkAccount` | calendar/ipc.ts:38 | `calendar.unlinkAccount` | preload:329 |
| `calendar:syncNow` | calendar/ipc.ts:39 | `calendar.syncNow` | preload:330 |
| `calendar:listInRange` | calendar/ipc.ts:40 (body wraps to :42) | `calendar.listInRange` | preload:331-332 |
| `calendar:createLocal` | calendar/ipc.ts:43 | `calendar.createLocal` | preload:333-334 |
| `calendar:updateLocal` | calendar/ipc.ts:44 (body wraps to :46) | `calendar.updateLocal` | preload:335-336 |
| `calendar:deleteLocal` | calendar/ipc.ts:47 | `calendar.deleteLocal` | preload:337 |

## mcp-servers (7 channels)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `mcp:list` | mcp-servers/ipc.ts:21 | `mcp.list` | preload:134 |
| `mcp:add` | mcp-servers/ipc.ts:22 | `mcp.add` | preload:135 |
| `mcp:update` | mcp-servers/ipc.ts:26 | `mcp.update` | preload:136 |
| `mcp:remove` | mcp-servers/ipc.ts:29 | `mcp.remove` | preload:137 |
| `mcp:setEnabled` | mcp-servers/ipc.ts:30 | `mcp.setEnabled` | preload:138 |
| `mcp:setToolOverride` | mcp-servers/ipc.ts:31 | `mcp.setToolOverride` | preload:139-140 |
| `mcp:getStatus` | **swarm-ipc.ts:67** | `mcp.getStatus` | preload:141 — NOT in mcp-servers/ipc.ts; status comes from the service process (live connection state) and is wired inside `wireSwarmIpc`, while CRUD (rows above) lives in mcp-servers/ipc.ts's `wireMcpConfigIpc` (see mcp-servers/ipc.ts:1-2 comment) |

## web-search (5 channels — `apps/desktop/src/main/web-search/ipc.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `webSearch:get` | web-search/ipc.ts:29 | `webSearch.get` | preload:159 |
| `webSearch:setProvider` | web-search/ipc.ts:31 | `webSearch.setProvider` | preload:160-161 |
| `webSearch:setKey` | web-search/ipc.ts:37 | `webSearch.setKey` | preload:162-163 |
| `webSearch:clearKey` | web-search/ipc.ts:44 | `webSearch.clearKey` | preload:164 |
| `webSearch:setSearxngUrl` | web-search/ipc.ts:50 | `webSearch.setSearxngUrl` | preload:165-166 |

## budgets (2 channels — `apps/desktop/src/main/budgets/ipc.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `budgets:get` | budgets/ipc.ts:22 | `budgets.get` | preload:191 |
| `budgets:set` | budgets/ipc.ts:24 | `budgets.set` | preload:192 |

## weather (3 channels — `apps/desktop/src/main/weather/ipc.ts`)

| channel | handler file:line | preload member | notes |
|---|---|---|---|
| `weather:getConfig` | weather/ipc.ts:68 | `weather.getConfig` | preload:177 |
| `weather:setConfig` | weather/ipc.ts:70 | `weather.setConfig` | preload:178 |
| `weather:getForecast` | weather/ipc.ts:77 | `weather.getForecast` | preload:179 — also has a service→main RPC twin (`weather.get_forecast`) that shares `resolveForecast()` but skips the broadcast (weather/ipc.ts:87-92); not a renderer channel, not counted here |

## workbench (11 channels — `apps/desktop/src/main/workbench/ipc.ts`)

All 11 rows below register through the **same single call site**, workbench/ipc.ts:36
(`ipcMain.handle(channel, handler)` inside a local `handle()` wrapper defined at
workbench/ipc.ts:32-38). Only that one line is a literal `ipcMain.handle(` grep hit; the
11 distinct channel strings appear as arguments to the wrapper, not to `ipcMain.handle`
directly. See Reconciliation → Grep-hit accounting for how this keeps the totals honest.

| channel | handler call site (via workbench/ipc.ts:36) | preload member | notes |
|---|---|---|---|
| `workbench:getAll` | workbench/ipc.ts:40 | `workbench.getAll` | preload:203 |
| `workbench:createTask` | workbench/ipc.ts:42 | `workbench.createTask` | preload:204 |
| `workbench:updateTask` | workbench/ipc.ts:48 | `workbench.updateTask` | preload:205 |
| `workbench:completeTask` | workbench/ipc.ts:54 | `workbench.completeTask` | preload:206 |
| `workbench:reopenTask` | workbench/ipc.ts:55 | `workbench.reopenTask` | preload:207 |
| `workbench:deleteTask` | workbench/ipc.ts:56 | `workbench.deleteTask` | preload:208 |
| `workbench:moveTask` | workbench/ipc.ts:58 | `workbench.moveTask` | preload:209 |
| `workbench:addColumn` | workbench/ipc.ts:64 | `workbench.addColumn` | preload:210 |
| `workbench:renameColumn` | workbench/ipc.ts:70 | `workbench.renameColumn` | preload:211 |
| `workbench:deleteColumn` | workbench/ipc.ts:76 | `workbench.deleteColumn` | preload:212 |
| `workbench:reorderColumns` | workbench/ipc.ts:77 | `workbench.reorderColumns` | preload:213-214 |

---

## Constants resolved (all 22 `/tmp/consts.txt` lines)

| # | const | file:line | literal value |
|---|---|---|---|
| 1 | `TRANSCRIBE_PROGRESS_CHANNEL` (exported) | bilibili/ipc.ts:48 | `'bilibili:transcribe:progress'` |
| 2 | `STATE_CHANGED_CHANNEL` | providers/ipc.ts:18 | `'providers:stateChanged'` |
| 3 | `NAVIGATE_CHANNEL` | system/deep-link.ts:18 | `'swarm:navigate'` |
| 4 | `UPDATE_READY_CHANNEL` | system/auto-update.ts:13 | `'system:updateReady'` |
| 5 | `STATE_CHANGED_CHANNEL` | workbench/ipc.ts:19 | `'workbench:stateChanged'` |
| 6 | `STATE_CHANGED_CHANNEL` | web-search/ipc.ts:14 | `'webSearch:stateChanged'` |
| 7 | `STATE_CHANGED_CHANNEL` | budgets/ipc.ts:11 | `'budgets:stateChanged'` |
| 8 | `ACCENT_CHANGE_CHANNEL` (local, inside `wireSwarmIpc`) | ipc/swarm-ipc.ts:269 | `'system:accentChange'` |
| 9 | `FORECAST_CHANNEL` | weather/ipc.ts:13 | `'weather:forecastChanged'` |
| 10 | `SETTINGS_NAV_CHANNEL` | windows/open-settings.ts:14 | `'swarm:navigate-settings'` |
| 11 | `MCP_CONFIG_CHANGED_CHANNEL` (exported) | mcp-servers/ipc.ts:8 | `'mcp:configChanged'` |
| 12 | `IPC_EVENT_CHANNEL` | preload/index.ts:82 | `'swarm:event'` |
| 13 | `NAVIGATE_CHANNEL` | preload/index.ts:83 | `'swarm:navigate'` |
| 14 | `SETTINGS_NAV_CHANNEL` | preload/index.ts:84 | `'swarm:navigate-settings'` |
| 15 | `ACCENT_CHANGE_CHANNEL` | preload/index.ts:85 | `'system:accentChange'` |
| 16 | `PROVIDERS_STATE_CHANNEL` | preload/index.ts:86 | `'providers:stateChanged'` |
| 17 | `MCP_CONFIG_CHANGED_CHANNEL` | preload/index.ts:87 | `'mcp:configChanged'` |
| 18 | `MCP_STATUS_CHANNEL` | preload/index.ts:88 | `'mcp:status'` |
| 19 | `WEB_SEARCH_STATE_CHANNEL` | preload/index.ts:89 | `'webSearch:stateChanged'` |
| 20 | `WEATHER_FORECAST_CHANNEL` | preload/index.ts:90 | `'weather:forecastChanged'` |
| 21 | `BUDGETS_STATE_CHANNEL` | preload/index.ts:91 | `'budgets:stateChanged'` |
| 22 | `WORKBENCH_STATE_CHANNEL` | preload/index.ts:92 | `'workbench:stateChanged'` |

Every one of these 22 constants is a `_CHANNEL`-suffixed name; 11 are declared in main-process
domain files (rows 1-11, each paired with a `webContents.send`), and the other 11 are the
preload's own local copies (rows 12-22) used at its `ipcRenderer.on` call sites. Rows 2/5/6/7
show the same name `STATE_CHANGED_CHANNEL` reused across four unrelated files with four
different literal values — resolved individually so no reader confuses them.

---

## Reconciliation

### Preload invokes with no matching `ipcMain.handle` (dead calls)

**None found.** Every one of the 149 distinct invoke channels above has a matching handle
registration (see per-domain tables). `system:pickPath` is invoked from two preload members
(`pickDirectory`, `pickFile`) against the one handler — that's an intentional shared handler,
not an orphan.

### Handles with no preload caller (main-only / WS-era leftovers)

**None found.** Every one of the 149 distinct handle channels above has a matching preload
`ipcRenderer.invoke` call site. `mcp:getStatus` looked suspicious at first glance (registered
in `swarm-ipc.ts` rather than `mcp-servers/ipc.ts` alongside its sibling `mcp:*` channels) but
does have a live preload caller (`mcp.getStatus`, preload:141).

### Grep-hit accounting (proves the 139/150/14/15 raw counts reconcile)

- **handles.txt (139 raw hits) → 149 table rows.** 138 hits map 1:1 to a row. The remaining
  1 hit — workbench/ipc.ts:36, the `ipcMain.handle(channel, handler)` line inside the local
  `handle()` wrapper — is the single literal `ipcMain.handle(` call site through which all
  **11** `workbench:*` channels are registered (see the workbench table above for each
  channel's real call-site line). Net: 138 + 11 = 149.
- **invokes.txt (150 raw hits) → 149 table rows.** 149 hits map 1:1 to a row. The remaining
  1 hit — preload/index.ts:145 (`pickFile`) — shares its channel (`system:pickPath`) with the
  row already produced by preload/index.ts:144 (`pickDirectory`); both preload members are
  listed together in that single `system:pickPath` row rather than duplicated. Net:
  149 + 1(collapsed) = 150.
- **Both sides land on the same 149 distinct channels** (verified name-by-name per domain
  above), which is why the invoke/handle Dead-call sections above are empty.
- **subs.txt (14 raw hits) → 14 event rows**, all mapping 1:1 (see Events table below).
- **sends.txt (15 raw hits) → 15 event rows.** 12 hits map 1:1. 1 hit — main/index.ts:151,
  whose `channel` variable is computed at index.ts:148 (`event.startsWith('mcp.') ? 'mcp:status'
  : 'swarm:event'`) — fans out to **2** event rows (`swarm:event`, `mcp:status`). 2 hits —
  system/deep-link.ts:27 and quick-panel/ipc.ts:42 — both send the literal `swarm:navigate` and
  collapse into **1** event row. Net: 12 + 2(fan-out) + 1(collapsed pair) = 15.

Total raw grep hits accounted for: 139 + 150 + 14 + 15 = 318. ✓

### Event channels (`webContents.send` / `ipcRenderer.on`) — all 15, with payload types

| channel | sender file:line | subscriber (preload member) | payload type | notes |
|---|---|---|---|---|
| `swarm:event` | main/index.ts:151 (dynamic `channel` var, non-`mcp.*` branch) | preload:413-419, `swarm.subscribeEvents` (`IPC_EVENT_CHANNEL`) | `UIEvent` (`toRendererEvent(event, data)`, index.ts:149) | general session/task event stream |
| `mcp:status` | main/index.ts:151 (dynamic `channel` var, `event.startsWith('mcp.')` branch) | preload:149-155, `mcp.onStatus` (`MCP_STATUS_CHANNEL`) | `McpServerStatus[]` (raw service `data`, index.ts:149) | routed away from `swarm:event` specifically so it doesn't create a phantom task stub (index.ts:146-147 comment) |
| `mcp:configChanged` | mcp-servers/ipc.ts:12 (generic `broadcast(channel, payload)`), called at :19 with `MCP_CONFIG_CHANGED_CHANNEL` | preload:142-148, `mcp.onConfigChanged` | `McpServerConfig[]` | |
| `providers:stateChanged` | providers/ipc.ts:33 (generic `broadcast`), called at :38 with `STATE_CHANGED_CHANNEL` | preload:124-130, `providers.onStateChanged` | `ProvidersStateView` | |
| `webSearch:stateChanged` | web-search/ipc.ts:25 | preload:167-173, `webSearch.onStateChanged` | `WebSearchConfigView` | |
| `weather:forecastChanged` | weather/ipc.ts:35 | preload:180-186, `weather.onForecast` | `WeatherForecast` | |
| `budgets:stateChanged` | budgets/ipc.ts:18 | preload:193-199, `budgets.onStateChanged` | `BudgetConfig` | |
| `workbench:stateChanged` | workbench/ipc.ts:26 | preload:215-221, `workbench.onStateChanged` | `WorkbenchData` | |
| `bilibili:transcribe:progress` | bilibili/ipc.ts:140 | preload:270-276, `bilibili.onTranscribeProgress` | `BiliTranscribeProgress` | |
| `gmail:stateChanged` | gmail/ipc.ts:29 | preload:314-320, `gmail.onStateChanged` | `GmailConfigView` | |
| `calendar:stateChanged` | calendar/ipc.ts:30 | preload:338-344, `calendar.onStateChanged` | `CalendarConfigView` | |
| `swarm:navigate` | **two senders**: system/deep-link.ts:27 (`{sessionId}`) and quick-panel/ipc.ts:42 (`{route: payload.navigate}`) | preload:420-427, `swarm.onNavigateToSession` | `{sessionId?: string; route?: string}` | preload's listener type already unions both shapes (preload:421) |
| `swarm:navigate-settings` | windows/open-settings.ts:25 | preload:428-434, `swarm.onNavigateToSettings` | `{route: string}` | **navigate-settings channel** — Task 2 dependency |
| `system:accentChange` | ipc/swarm-ipc.ts:272 (const declared locally at :269) | preload:438-444, `swarm.onAccentChange` | `{hex: string}` | |
| `system:updateReady` | system/auto-update.ts:24 | **NONE — see Dead event below** | *(no payload arg — `send(UPDATE_READY_CHANNEL)`)* | |

### Dead event: `system:updateReady` has no subscriber

`UPDATE_READY_CHANNEL` (`'system:updateReady'`, system/auto-update.ts:13) is broadcast from
`system/auto-update.ts:24` on electron-updater's `'update-downloaded'` event, but no
`ipcRenderer.on` anywhere in `preload/index.ts` listens for it, and no `swarm.*` bridge member
exposes it. The renderer currently has **no way** to know an update is staged for next launch —
either an intentionally deferred v1 feature (the file's header comment says "ship G.62: auto-update
is a real silent process, not a 'please download a new version' link") or a wiring gap. Flagged
here per the task brief ("list, do not fix").

### Quick-panel hotkey channels (Task 2 dependency)

- `swarm:quickPanel:getHotkey` — handle: quick-panel/ipc.ts:51; preload: `swarm.quickPanel.getHotkey` (preload:480)
- `swarm:quickPanel:setHotkey` — handle: quick-panel/ipc.ts:55; preload: `swarm.quickPanel.setHotkey` (preload:481-482)
- (sibling, non-hotkey quick-panel channels for completeness: `swarm:quickPanel:hide`, `swarm:quickPanel:focusMain`)

### Navigate-settings channel (Task 2 dependency)

- `swarm:navigate-settings` (`SETTINGS_NAV_CHANNEL`) — sender: windows/open-settings.ts:25; subscriber: `swarm.onNavigateToSettings` (preload:428-434); literal declared independently in windows/open-settings.ts:14 and preload/index.ts:84 (same value, two declarations — see Constants resolved rows 10/14).
