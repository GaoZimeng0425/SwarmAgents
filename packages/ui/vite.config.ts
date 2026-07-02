// shadcn CLI requires a framework marker (vite.config.*) to detect the project
// type before `apply`/`add`. This file exists solely for that detection — the
// package has no build step and is consumed from source via the apps' vite
// aliases. It lives outside the package tsconfig `include`, so it is never
// typechecked, and turbo never builds it (no `build` script).
export default {}
