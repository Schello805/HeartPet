function createRuntimeMetrics() {
  const state = {
    startedAt: Date.now(),
    requests: 0,
    errors: 0,
    totalDurationMs: 0,
    slowestDurationMs: 0,
    recent: [],
  };

  function middleware(req, res, next) {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      if (req.path.startsWith("/static/")) return;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      state.requests += 1;
      state.totalDurationMs += durationMs;
      state.slowestDurationMs = Math.max(state.slowestDurationMs, durationMs);
      if (res.statusCode >= 500) state.errors += 1;
      state.recent.push({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
        at: new Date().toISOString(),
      });
      if (state.recent.length > 50) state.recent.shift();
    });
    next();
  }

  function snapshot() {
    return {
      uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
      requests: state.requests,
      errors: state.errors,
      averageDurationMs: state.requests ? Math.round(state.totalDurationMs / state.requests) : 0,
      slowestDurationMs: Math.round(state.slowestDurationMs),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      recent: state.recent.slice(-10).reverse(),
    };
  }

  return { middleware, snapshot };
}

module.exports = { createRuntimeMetrics };
