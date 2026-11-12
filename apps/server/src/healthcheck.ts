/**
 * Container health probe: exits 0 when /healthz answers 200.
 * It imports nothing from the application, so running it every 30 seconds costs almost nothing.
 */
const port = process.env.PORT?.trim() || "3000";

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) console.error(await response.text());
  process.exitCode = response.ok ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

// Marks the file as a module for every compiler configuration, so top-level await is allowed.
export {};
