# ADR 0032 — Local models: the desktop hub installs, runs and manages Ollama

Status: **Accepted** by the owner, 2026-10-30. What the owner decided:
- Local models live on the computer only. They are not on the server image, and phones may come later.
- Ollama comes first.
- On Windows and Linux, the hub downloads only the graphics libraries this computer needs.
- An Ollama that is already on the computer is managed by the hub, which says it did not install it.
- An Ollama the hub installs is fully the hub's to run. It stops with the hub, and the hub adds and deletes its models and updates it.

The details below that the owner did not name are the implementer's choices.

## Context

The owner wants to repair his computer, and the hub itself, when the internet is the problem. That needs a model that runs on the computer. Today a person can add Ollama as a provider (`catalogue.ts`), but only after installing it themselves.

The owner wants the hub to do what it does for coding agents:
- fetch the program from its vendor;
- keep it up to date;
- manage its models;
- add nothing to the hub's own download (the installer stays ~100–300 MB).

We compared Ollama with the alternatives: llama.cpp, LM Studio, MLX, Jan, GPT4All, LocalAI and llamafile.

Ollama was chosen for four reasons:
- It is MIT-licensed.
- It has a model library.
- It has an API to pull and delete models.
- Since v0.40.0 it runs models on MLX by default on Apple silicon, and its Mac download is ~180 MB.

Its Windows and Linux releases are ~1.5 GB because they carry every graphics card's libraries. That is what §3 addresses.

## Decision

### 1. Where it is offered

The hub offers local models only when it is the desktop app's own hub. A hub knows this because the desktop app started it (`relayHost`). `COREHUB_LOCAL_MODELS` (optional) can change this:
- `auto` is the default;
- `on` offers it on any hub, such as a developer's;
- `off` offers it nowhere.

On the server image the screen reports `available: false` and nothing runs.

Who can use it:
- Every route is for the owner and admins.
- The section shows only on the Models screen, General tab.

### 2. Two kinds of Ollama

| | managed | external |
|---|---|---|
| How it got here | The hub installed it into `<DATA_DIR>/runtimes/ollama/app` | The person installed it; it answers on `127.0.0.1:11434` |
| Starts and stops | With the hub (its child process); Start and Stop on the screen | Never by the hub |
| Models | Pull, delete, list; stored in `<DATA_DIR>/runtimes/ollama/models` | Pull, delete, list, through its API |
| Update | The newest release, from the screen, as a job | The screen says a newer one exists; the person updates it |
| Remove | From the screen, keeping or deleting the models | Never by the hub |

A managed Ollama listens on `127.0.0.1` only. It uses port 11434 when that is free, and otherwise a free port it keeps from then on.

Either way, the hub points the provider row `ollama` (shared) at it. Then every agent and the model gateway (ADR 0029) can use local models, the Hermes helper (ADR 0031) included.
- An existing `ollama` row is moved only to the Ollama the hub runs.
- A row the person pointed at another computer is left alone when an external Ollama merely appears on this one.

### 3. What is downloaded

The release is always the vendor's newest. The tag is read from the redirect of `releases/latest`, which avoids GitHub's API limit.

| Platform | File | What crosses the network | Check |
|---|---|---|---|
| Mac | `ollama-darwin.tgz` (~180 MB, Metal and MLX inside) | the whole file | the SHA-256 the release publishes in `sha256sum.txt` |
| Linux | `ollama-linux-<arch>.tar.zst` (~1.5 GB) | the whole file; the CUDA folders the computer does not need are excluded from unpacking | the published SHA-256 |
| Windows | `ollama-windows-<arch>.zip` (~1.5 GB) | **only the entries this computer needs**, by HTTP `Range` after reading the zip's index: ~40 MB without NVIDIA, ~645 MB with CUDA 13 (measured on v0.40.13) | each entry's CRC-32 and size from the zip's index, over TLS |

How the CUDA folder is chosen:
- NVIDIA's driver version picks it: r580 or newer gets `cuda_v13`, older drivers get `cuda_v12`.
- Every other card (AMD, Intel, none) keeps no CUDA folder and uses Vulkan, which every install carries.
- ROCm and the separate MLX archives are not downloaded.

**The Windows trade:**
- The release's SHA-256 covers the whole zip, so it cannot be checked when only part of the zip is fetched.
- The bytes come from the vendor's release over TLS, and each entry must match the zip's own record.
- The owner chose the smaller download.

Installs and updates are staged:
- The new program replaces `app/` only when it is complete.
- A failed update starts the old program again.

### 4. Models

The screen lists three things:
- the installed models;
- the models loaded now;
- a short list of suggested models. Each one can call tools and shows its approximate size and whether this computer's memory fits it.

Any library name can also be typed in.

A download is a job (`kind: install`) whose progress carries the bytes, and cancelling the job stops it. After a model comes or goes, the `ollama` provider's model list is fetched again.

### 5. Lifecycle

- A managed Ollama starts in the background when the hub starts, and never holds boot.
- It stops when the hub stops.
- If it dies, it is restarted at most three times in a minute.

## Consequences

- **No contract change to what exists.** There are nine new operations under `/models/local-runtime`, and their jobs use the existing kinds `install` and `update`. No new `JobKind` value reaches the phones.
- **Additive configuration.** The optional `COREHUB_LOCAL_MODELS` is new, and the desktop app needs no change.
- **A hard crash of the hub** (not a normal quit) leaves its Ollama running until the hub starts again. At that start it stops it: the process id is kept in `ollama.pid`, and it is stopped only if that process is still an Ollama. A normal quit stops Ollama in `preClose`, before the server waits for open connections.
- **Updates follow the vendor.** Unlike catalog agents (pinned hashes moved by a pull request), the newest Ollama is installed without our review. The checks are the vendor's own: the published hash, or the zip's records.
- **Later:**
  - The Hermes helper switches to a local model when the internet is down.
  - llama.cpp directly on Windows and Linux, if the CUDA download proves too large.
  - LM Studio, detected only.
  - Phones.
