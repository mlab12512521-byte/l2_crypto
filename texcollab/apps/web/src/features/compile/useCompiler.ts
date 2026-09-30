import type { CompileResult } from '@texcollab/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { projectsApi } from '../../api/projects';

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

/**
 * Compilation state for a project: the latest build, manual and automatic
 * compilation. Automatic compilation runs a short while after edits are
 * saved; if edits arrive during a compile, it compiles again afterwards.
 */
export function useCompiler(projectId: string, flushEdits: () => Promise<void>) {
  const [result, setResult] = useState<CompileResult | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoKey = `texcollab.autocompile.${projectId}`;
  const [autoCompile, setAutoCompileState] = useState(() => loadBool(autoKey, true));
  const running = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushRef = useRef(flushEdits);
  flushRef.current = flushEdits;

  useEffect(() => {
    let cancelled = false;
    projectsApi.latestBuild(projectId).then(
      (r) => !cancelled && setResult(r.build),
      () => undefined,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [projectId]);

  const compile = useCallback(async () => {
    clearTimeout(timer.current);
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    setCompiling(true);
    setError(null);
    try {
      await flushRef.current();
      for (let attempt = 0; ; attempt++) {
        try {
          setResult(await projectsApi.compile(projectId));
          break;
        } catch (err) {
          // Another collaborator's compile of this project is running: wait and retry.
          if (err instanceof ApiError && err.status === 409 && attempt < 20) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compilation failed');
    } finally {
      running.current = false;
      setCompiling(false);
      if (again.current) {
        again.current = false;
        timer.current = setTimeout(() => void compile(), 300);
      }
    }
  }, [projectId]);

  /** Call after edits were saved: schedules an automatic compile if enabled. */
  const notifyEdited = useCallback(() => {
    if (!autoCompile) return;
    if (running.current) {
      again.current = true;
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void compile(), 1500);
  }, [autoCompile, compile]);

  const setAutoCompile = useCallback(
    (v: boolean) => {
      setAutoCompileState(v);
      try {
        localStorage.setItem(autoKey, v ? '1' : '0');
      } catch {
        // Preference just is not remembered.
      }
    },
    [autoKey],
  );

  /** Reload the latest build (e.g. a collaborator compiled). */
  const refresh = useCallback(async () => {
    if (running.current) return;
    try {
      const r = await projectsApi.latestBuild(projectId);
      setResult(r.build);
    } catch {
      // Keep the current state; the next compile will update it.
    }
  }, [projectId]);

  // Keep showing the last PDF when a new build produced none (e.g. fatal errors).
  const [pdf, setPdf] = useState<{ url: string; buildId: string } | null>(null);
  useEffect(() => {
    if (result?.outputFiles.some((f) => f.name === 'output.pdf')) {
      setPdf({ url: projectsApi.buildFileUrl(projectId, result.buildId, 'output.pdf'), buildId: result.buildId });
    }
  }, [result, projectId]);

  return {
    result,
    compiling,
    error,
    compile,
    refresh,
    notifyEdited,
    autoCompile,
    setAutoCompile,
    pdfUrl: pdf?.url ?? null,
    /** Build that produced the PDF on screen (for SyncTeX). */
    pdfBuildId: pdf?.buildId ?? null,
  };
}
