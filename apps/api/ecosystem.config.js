/**
 * PM2 Ecosystem Configuration — Trading Intelligence API
 *
 * Production process manager configuration for the Trading Intelligence
 * Express backend. PM2 provides cluster mode for multi-core utilization,
 * automatic restarts on failure, log management, and graceful reloads.
 *
 * Usage:
 *   Development : pm2 start ecosystem.config.js
 *   Production  : pm2 start ecosystem.config.js --env production
 *   Reload      : pm2 reload trading-intelligence-api
 *   Stop        : pm2 stop trading-intelligence-api
 *   Logs        : pm2 logs trading-intelligence-api
 *
 * Prerequisites:
 *   - Compiled TypeScript output in ./dist/ (run `pnpm build` first)
 *   - Environment variables set in system env or .env file
 *   - PostgreSQL and Redis services running
 *
 * Note: This file uses ESM `export default` because the project's
 * package.json specifies "type": "module". PM2 v5.x supports ESM
 * ecosystem config files via dynamic import().
 */

/**
 * PM2 ecosystem configuration object.
 * Defines the application deployment profile including cluster mode,
 * environment variables, logging, restart policies, and Node.js runtime flags.
 */
const pm2Config = {
  apps: [
    {
      // ─── Application Identity ───────────────────────────────────────
      /** Unique application name used by PM2 for process identification */
      name: "trading-intelligence-api",

      /**
       * Entry point — compiled TypeScript output.
       * Ensure `pnpm build` has been run before starting with PM2.
       */
      script: "./dist/index.js",

      /**
       * Working directory relative to the monorepo root.
       * When running PM2 from the repo root, this directs execution
       * into the apps/api workspace. For standalone deployment where
       * apps/api is the root, set to "./" or remove this field.
       */
      cwd: "./apps/api",

      // ─── Cluster Mode Configuration ─────────────────────────────────
      /**
       * Number of worker instances to spawn.
       * - "max" utilizes all available CPU cores for maximum throughput.
       * - Override via PM2_INSTANCES env var for fine-grained control
       *   in resource-constrained environments (e.g., containers).
       */
      instances: process.env.PM2_INSTANCES || "max",

      /** Enable PM2 cluster mode for built-in load balancing across workers */
      exec_mode: "cluster",

      /**
       * Auto-restart any worker that exceeds this memory threshold.
       * Prevents memory leaks from degrading the entire cluster.
       * 500MB is generous for an Express API with LLM orchestration overhead.
       */
      max_memory_restart: "500M",

      // ─── Environment Variables ──────────────────────────────────────
      /**
       * Default environment (development).
       * Active when started without --env flag.
       * All sensitive env vars (DATABASE_URL, REDIS_URL, API keys)
       * are loaded from .env file or system environment — only
       * universal runtime flags are defined here.
       */
      env: {
        NODE_ENV: "development",
        PORT: 3000,
      },

      /**
       * Production environment overrides.
       * Active when started with: pm2 start ecosystem.config.js --env production
       */
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
      },

      // ─── Log Configuration ──────────────────────────────────────────
      /**
       * Timestamp format prepended to PM2-managed log entries.
       * Matches ISO-like format for correlation with Pino structured logs.
       */
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      /** Stderr log file path (relative to cwd) */
      error_file: "./logs/api-error.log",

      /** Stdout log file path (relative to cwd) */
      out_file: "./logs/api-out.log",

      /**
       * Merge logs from all cluster workers into a single file per stream.
       * Without this, PM2 creates separate log files per worker instance
       * (e.g., api-out-0.log, api-out-1.log), making log aggregation harder.
       */
      merge_logs: true,

      /**
       * Output log format. Set to "json" to preserve Pino's structured
       * JSON log output, enabling downstream log processors (ELK, Loki)
       * to parse entries without custom regex.
       */
      log_type: "json",

      // ─── Restart and Watch Configuration ────────────────────────────
      /** Auto-restart the process on unexpected exit (crash recovery) */
      autorestart: true,

      /**
       * File watching is disabled in production.
       * Use `pm2 reload` for zero-downtime reloads after deployment.
       * Watching is a development concern handled by tsx/nodemon instead.
       */
      watch: false,

      /**
       * Maximum number of consecutive restarts before PM2 gives up.
       * Prevents infinite restart loops from persistent fatal errors
       * (e.g., missing DATABASE_URL, port conflict).
       */
      max_restarts: 10,

      /**
       * Minimum uptime threshold for a process to be considered "started".
       * If a process crashes before this duration, it counts toward
       * the max_restarts limit. 10 seconds allows time for database
       * connections and queue initialization.
       */
      min_uptime: "10s",

      /**
       * Delay in milliseconds between automatic restart attempts.
       * 4 seconds provides breathing room for transient issues
       * (port release, connection pool cleanup) to resolve.
       */
      restart_delay: 4000,

      /**
       * Graceful shutdown timeout in milliseconds.
       * Time allotted for the process to handle SIGINT, close database
       * connections, drain BullMQ workers, and flush Pino log buffers
       * before PM2 sends SIGKILL.
       */
      kill_timeout: 5000,

      /**
       * Maximum time (ms) PM2 waits for the app to emit the "listening"
       * event (or equivalent) before considering the startup failed.
       * 10 seconds accounts for database migration checks and
       * Redis connection establishment at boot.
       */
      listen_timeout: 10000,

      // ─── Node.js Runtime Arguments ──────────────────────────────────
      /**
       * V8 and Node.js flags passed to each worker process.
       * - --max-old-space-size=512: Caps V8 heap at 512MB per worker,
       *   complementing max_memory_restart for predictable memory usage.
       * - --enable-source-maps: Maps compiled JS stack traces back to
       *   TypeScript source for accurate production error diagnostics.
       */
      node_args: "--max-old-space-size=512 --enable-source-maps",
    },
  ],
};

export default pm2Config;
