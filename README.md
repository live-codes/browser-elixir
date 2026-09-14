# Browser Elixir

Run Elixir **entirely in the browser** — no server, no upload, no install. The Elixir compiler
itself executes in WebAssembly, so a snippet typed into the page is evaluated in that tab.

It is built on **[Popcorn](https://github.com/software-mansion/popcorn)** 0.3, which runs
[AtomVM](https://github.com/atomvm/AtomVM) (a small Erlang VM) compiled to WebAssembly, plus an
`eval-in-wasm` bundle that carries the Elixir compiler inside the VM. That bundle is why a
playground works at all: without it every snippet would need a build step.

This is the runtime behind adding an `elixir` language to [LiveCodes](https://livecodes.io), in
the same shape as [`browser-haskell`](https://github.com/live-codes/browser-haskell) was for
`haskell-wasm`.

## Demo

```bash
npm start          # → http://localhost:8125/   (alias for: node serve.js)
```

Open that page, pick an example from the dropdown (or type your own), and press **Run** — or
`Ctrl`/`Cmd` + `Enter` in the editor. The result pane shows `inspect/1` of the last expression;
the output pane shows `stdout` and `stderr` as the program produces them.

**A server is required**, and it must set the two cross-origin isolation headers — see
[Limitations](#limitations). `file://` will not work, and neither will a plain static server.

## What you get

- **Client-side evaluation.** `Code.eval_string/3` runs inside the tab; nothing is uploaded.
- **Real Elixir**, not a transpiler: modules, pattern matching, pipes, comprehensions,
  `Enum`/`Map`/`String`, `inspect/1` formatting.
- **Processes work.** `spawn`/`send`/`receive` and `GenServer` run on AtomVM (the runtime's own
  eval server is a GenServer).
- **`ETS` and `:crypto` work** — `:crypto.hash(:sha256, "abc")` returns the correct digest.
- **`try`/`rescue` works**, so runtime errors are catchable (see below).
- **Self-healing.** An uncaught error aborts the VM, so the driver detects the dead instance and
  restarts it rather than leaving the page broken.
- **No build step and no dependencies** — plain ES modules plus prebuilt wasm. `npm start` is the
  whole toolchain.

## Language support

AtomVM implements a **subset** of Elixir/OTP. Measured against this bundle (full evidence with
outputs and timings in [FINDINGS.md](FINDINGS.md)):

| Works | Does not work |
| --- | --- |
| Integers **and floats** (`1.5 + 1.5` → `3.0`, `7 / 2` → `3.5`) | **Regex** — `Regex.match?/2` aborts on a missing NIF |
| `Enum`, `Map`, `String`, comprehensions, recursion | **`DateTime`/`os` time** — `os:system_time/0` NIF missing |
| `defmodule` + function calls | **`Task`** — `erlang:monitor/3` NIF missing |
| `spawn`/`send`/`receive`, `GenServer` | **`Float.round/2`** — dies with no diagnostic at all |
| `:ets`, `:crypto` | **Structs** (`defstruct` + `%S{}` in one eval) — compile error |
| `IO.puts`, `IO.inspect`, `inspect/1` | **Loops forever** — nothing can interrupt it |
| `try`/`rescue`/`catch` of runtime errors | |

Two quirks worth knowing:

- **`defmodule` inside the editor is namespaced as `EvalInWasm.<Name>`.** The eval runs with the
  host module's environment, so a function call like `Fib.of(20)` resolves, but `%Fib{}` struct
  literal expansion does not. Define a module and call it; do not reach for its struct literal.
- **Errors are only fatal when uncaught.** `try do ... rescue e -> Exception.message(e) end`
  catches runtime errors (including `ArithmeticError`). A *compile* error (bad syntax, bad struct)
  or a missing NIF cannot be caught — the VM aborts regardless.

## Limitations

- **Cross-origin isolation is mandatory.** The page must be served with
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
  Verified both ways: without them `SharedArrayBuffer` is `undefined`, `crossOriginIsolated` is
  `false`, and `Popcorn.init()` never returns. `serve.js` sets both; the `--no-isolation` flag
  exists precisely so this can be demonstrated. **This is the main open question for LiveCodes
  embedding**, where the top-level document's headers are not ours to choose.
- **An uncaught error costs a restart.** It is indistinguishable from a slow program, so the UI
  waits out a 15 s timeout and then restarts the runtime. Lower `EVAL_TIMEOUT_MS` in
  `public/main.js` to trade patience for snappier failure.
- **No `stdin`.** AtomVM in wasm has no file descriptor 0, so `IO.gets` has nothing to read.
  Evaluation-style snippets only.
- **8.1 MB of runtime** (997 KB `AtomVM.wasm` + 7.1 MB `bundle.avm`, which contains the compiler).
  Cached hard after the first load; the eventual LiveCodes entry will need `largeDownload: true`.
- **Terse diagnostics**, in AtomVM's own format, sometimes naming internals
  (`function :elixir.eval_external_handler/3 is undefined or private`).
- **The vendored artifacts are not built here.** See [public/wasm/VERSION.md](public/wasm/VERSION.md)
  — the runtime and the bundle are version-locked and must travel together.

## Layout

```
public/index.html     the harness page (editor, result, stdout/stderr, timings)
public/main.js        the driver: boots Popcorn, runs snippets, recovers a dead VM
public/wasm/          the vendored runtime — 5 files, one matched set (see VERSION.md)
serve.js              static server: COOP/COEP, MIME types, caching, --no-isolation
FINDINGS.md           the spike log: what was verified, what breaks, what it means
```

There is no bundler and no `node_modules`.

## Verifying

The demo is verified by *running* it, not by importing it — see [FINDINGS.md](FINDINGS.md) for the
recorded outputs. Everything below needs no bundler:

| what | command |
| --- | --- |
| serve the page | `npm start` → http://localhost:8125/ |
| check syntax | `npm run check` |
| prove isolation is required | `npm run start:no-isolation`, then reload — boot fails |

## Status

Spike complete. The page boots AtomVM, evaluates Elixir, streams `stdout`/`stderr`, reports
`inspect/1` of the result, survives an aborted VM, and is verified end to end in headless Chrome.

Next: the LiveCodes `lang-elixir` entry (`vendors.ts` URL, build-script and docs wiring), and
owning the build — cooking our own `bundle.avm` against a pinned `@swmansion/popcorn` so the
runtime can be served from a CDN instead of vendored.

## License

MIT © Hatem Hosny. Popcorn, AtomVM and the vendored runtime are Apache-2.0; see
[LICENSE](LICENSE) and [public/wasm/VERSION.md](public/wasm/VERSION.md) for provenance.
