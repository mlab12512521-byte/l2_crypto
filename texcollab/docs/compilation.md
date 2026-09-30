# LaTeX compilation

## How it works

1. A user clicks **Recompile** (or presses `Ctrl/Cmd+S`, `Ctrl/Cmd+Enter`),
   or automatic compilation fires ~1.5 s after edits are saved.
2. The app takes a consistent snapshot of the project (latest text of every
   document, binary files from the blob store), packs it into a tar archive
   and sends it to a compile worker in a signed request.
3. The worker starts a fresh sandbox container (see
   [security-model.md §5](security-model.md#5-latex-compilation-sandbox)),
   which runs `latexmk` with the selected engine from the project root:

   ```
   latexmk -norc -r /etc/texcollab/latexmkrc -pdf|-xelatex|-lualatex \
           -jobname=output -interaction=nonstopmode -file-line-error \
           -synctex=1 -f -no-shell-escape <main file>
   ```

   latexmk runs as many passes as needed (up to 6) and runs BibTeX or Biber
   and makeindex automatically.
4. The app stores `output.pdf`, `output.log`, `output.blg` and
   `output.synctex.gz` under `/data/builds/<project>/<build>/`, parses the
   logs into diagnostics and returns them to the browser.

At most one compilation per project runs at a time; the last few builds are
kept (`compileLimits.keepBuilds`, default 3).

## Engines

| Engine | Use for |
|---|---|
| `pdflatex` (default) | Most documents; fastest; widest package compatibility |
| `xelatex` | System/OpenType fonts via `fontspec`, Unicode input |
| `lualatex` | `fontspec`, Lua scripting (`\directlua`), modern packages |

The engine is a project setting (editors can change it in the toolbar).

## Project conventions

* Paths in `\input`, `\include`, `\includegraphics`, `\bibliography` are
  relative to the **project root**, also when the main file is in a
  subfolder (same as Overleaf).
* The main file is marked "main" in the file tree; change it with a
  right-click → *Set as main file*. ZIP imports detect it automatically.
* Shell escape is not available, so packages that need it will not work:
  `minted` (use `listings`), `svg` conversion (convert to PDF first),
  `gnuplottex`, `epstopdf` on-the-fly conversion of EPS (convert first),
  `\write18`-based tricks.

## Errors and warnings

Errors, warnings and bad boxes are extracted from the TeX log (the sandbox
uses `-file-line-error` and wide log lines for reliable parsing) and from
BibTeX/Biber logs. They appear

* as markers and underlines in the editor at the right file and line,
* as a red count on the file's tab and the **Logs** button,
* in the logs panel (click an entry to jump to the source); raw logs are
  linked there too.

## SyncTeX

* **Source → PDF:** place the cursor and click **→ PDF**; the matching
  region is highlighted in the viewer.
* **PDF → source:** double-click text in the PDF; the editor opens the file
  and moves the cursor to the line.

## Limits

Administrators set compile limits under *Administration → Compilation &
limits* (time, memory, CPU per compilation; builds kept). Workers enforce
their own maximums from their environment (`MAX_TIMEOUT_SECONDS`,
`MAX_MEMORY_MB`, `MAX_CPUS`, `MAX_CONCURRENCY`, `MAX_QUEUE`).

## The TeX Live image

`docker/texlive/Dockerfile` extends the official `texlive/texlive` image
(scheme-full by default, ~9 GB unpacked) with the sandbox entrypoint, the
trusted latexmk configuration, prebuilt LuaTeX and fontconfig font caches (so
lualatex and xelatex do not rescan all fonts in every sandbox) and a
pre-unpacked Biber runtime. Build it with

```sh
docker compose --profile build build texlive
```

Use `TEXLIVE_BASE_IMAGE` to pick a smaller scheme (e.g.
`texlive/texlive:latest-medium`) or to pin a dated release for reproducible
builds.

## Worker configuration

| Variable | Default | Meaning |
|---|---|---|
| `WORKER_SECRET` / `WORKER_SECRET_FILE` | — | Shared secret with the app (≥ 32 chars) |
| `COMPILE_IMAGE` | `texcollab/texlive:latest` | Sandbox image |
| `DOCKER_RUNTIME` | — | e.g. `runsc` (gVisor) |
| `MAX_CONCURRENCY` | CPUs/2 | Parallel compilations |
| `MAX_QUEUE` | 50 | Waiting compilations before answering "busy" |
| `MAX_TIMEOUT_SECONDS` / `MAX_MEMORY_MB` / `MAX_CPUS` | 300 / 4096 / 4 | Upper bounds for requested limits |
| `WORK_TMPFS_MB` | 1024 | Scratch space per compilation |
| `MAX_INPUT_MB` / `MAX_OUTPUT_MB` | 1024 / 256 | Archive size limits |
| `PIDS_LIMIT` | 256 | Processes per sandbox |

The app lists its workers in `COMPILE_WORKERS` (comma-separated URLs); jobs
are distributed round-robin and a busy worker's jobs go to the next one.
