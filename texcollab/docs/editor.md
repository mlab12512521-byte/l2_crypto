# The editor

TeXCollab's editor is CodeMirror 6 configured for LaTeX
(`apps/web/src/features/editor/`).

| Feature | Notes |
|---|---|
| Syntax highlighting | CodeMirror `stex` mode (MIT). Colours follow the light/dark theme. |
| Autocomplete | `\` + letters → commands and environment snippets. Inside `\ref{}`, `\eqref{}`, `\cref{}` … → labels from all `.tex` files of the project. Inside `\cite{}`, `\citep{}`, `\parencite{}` … → keys from all `.bib` files (with titles). `\includegraphics{}` → image files, `\input{}`/`\include{}` → `.tex` files, `\bibliography{}`/`\addbibresource{}` → `.bib` files, `\begin{}` → environments, `\usepackage{}` → common packages. Accept with Enter or Tab. |
| Search / replace | `Ctrl/Cmd+F`, `Ctrl/Cmd+Alt+F` (replace), `F3`/`Shift+F3`, regexp and case options. |
| Folding | Environments (`\begin…\end`, nesting-aware) and sectioning commands (up to the next heading of the same or higher level). `Ctrl/Cmd+Shift+[` / `]`. |
| Brackets | Matching highlight; auto-closing of `{`, `[`, `(`, `$`. |
| Multiple cursors | `Alt`+click, `Ctrl/Cmd+D` (select next occurrence), rectangular selection with `Alt`+drag. |
| Comments | `Ctrl/Cmd+/` toggles `%` line comments. |
| Formatting | `Ctrl/Cmd+B` → `\textbf{}`, `Ctrl/Cmd+I` → `\textit{}` (wraps the selection). |
| Compile | `Ctrl/Cmd+S` or `Ctrl/Cmd+Enter` (phase 4). |
| Tabs | Several files open at once; tabs and panel sizes are remembered per browser. |
| Error locations | Compiler errors/warnings appear as gutter markers and underlines (phase 4). |

Symbol data for completion comes from `GET /api/projects/:id/symbols`, which
extracts `\label{}`s (ignoring comments) and BibTeX keys on the server.
