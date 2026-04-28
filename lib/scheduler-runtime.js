"use strict";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-message safe-send delay with jitter. Plain 300ms produced a regular
// "machine-gun" cadence that anti-spam systems flag immediately. Picking
// a random delay in [base, base+jitter] gives the traffic a more
// human-like timing distribution.
function safeSendDelay() {
  const base = 800;
  const jitter = 1200;
  return base + Math.floor(Math.random() * jitter);
}

function isDue(item, now = Date.now()) {
  if (!item || item.sent || item.failed) return false;
  const scheduledAt = Date.parse(item.scheduledAt || "");
  return Number.isFinite(scheduledAt) && scheduledAt <= now;
}

function createSchedulerRuntime(deps = {}) {
  const {
    listScheduler,
    updateSchedulerItem,
    resolveTargets,
    getSocketForSession,
    emitSchedulerUpdate,
    logger,
    pollIntervalMs = 1500,
    maxRetries = 2,
  } = deps;

  const processing = new Set();
  // Per-session FIFO queues so a slow session can never block sends on
  // another connected session, but we still send messages to a single
  // session sequentially to respect WhatsApp rate limits.
  const sessionQueues = new Map();
  let timer = null;

  function enqueue(sessionId, task) {
    const key = sessionId || "__main__";
    const previous = sessionQueues.get(key) || Promise.resolve();
    const next = previous.then(task, task);
    sessionQueues.set(key, next.catch(() => {}));
    return next;
  }

  async function executeItem(item) {
    const id = item?.id;
    if (!id || processing.has(id)) return;
    processing.add(id);

    try {
      const session = getSocketForSession(item.sessionId);
      if (!session?.sock) {
        const failed = updateSchedulerItem(id, {
          failed: true,
          failedAt: new Date().toISOString(),
          lastError: `${session?.label || item.sessionId || "Selected bot"} is not connected`,
          attemptedTargets: 0,
          sentCount: 0,
          failedCount: 0,
        });
        if (failed) emitSchedulerUpdate(failed);
        return;
      }

      const targets = resolveTargets(item.targetType, item.targets);
      if (!targets.length) {
        const failed = updateSchedulerItem(id, {
          failed: true,
          failedAt: new Date().toISOString(),
          lastError: "No valid targets resolved for this scheduled job",
          attemptedTargets: 0,
          sentCount: 0,
          failedCount: 0,
        });
        if (failed) emitSchedulerUpdate(failed);
        return;
      }

      let sentCount = 0;
      let failedCount = 0;
      let lastError = null;

      // Run every send for this job through the per-session queue so
      // multiple jobs on the same bot serialize naturally.
      await enqueue(item.sessionId, async () => {
        for (const jid of targets) {
          let attempt = 0;
          let delivered = false;
          let attemptError = null;
          while (attempt <= maxRetries && !delivered) {
            try {
              await session.sock.sendMessage(jid, { text: item.message });
              delivered = true;
            } catch (error) {
              attemptError = error?.message || String(error);
              attempt += 1;
              if (attempt > maxRetries) break;
              // Exponential backoff between retries: 1s, 2s, 4s ...
              await delay(1000 * Math.pow(2, attempt - 1));
            }
          }
          if (delivered) {
            sentCount += 1;
          } else {
            failedCount += 1;
            lastError = attemptError;
          }

          // Progress updates so the dashboard can show live counts on
          // long broadcasts instead of one big jump at the end.
          try {
            const progress = updateSchedulerItem(id, {
              sentCount,
              failedCount,
              attemptedTargets: sentCount + failedCount,
              lastError,
            });
            if (progress) emitSchedulerUpdate(progress);
          } catch {}

          await delay(safeSendDelay());
        }
      });

      const attemptedTargets = sentCount + failedCount;
      const completedAt = new Date().toISOString();
      const partialFailure = failedCount > 0;
      const completed = updateSchedulerItem(id, {
        sent: sentCount > 0,
        sentAt: sentCount > 0 ? completedAt : null,
        failed: partialFailure,
        failedAt: partialFailure ? completedAt : null,
        lastError,
        sentCount,
        failedCount,
        attemptedTargets,
      });

      if (completed) {
        emitSchedulerUpdate(completed);
      }

      logger(
        `[Scheduler] Job ${id} processed via ${session.sessionId}: sent=${sentCount}, failed=${failedCount}, targets=${attemptedTargets}`
      );
    } catch (error) {
      const failed = updateSchedulerItem(id, {
        failed: true,
        failedAt: new Date().toISOString(),
        lastError: error?.message || String(error),
      });
      if (failed) emitSchedulerUpdate(failed);
      logger(`[Scheduler] Job ${id} crashed: ${error?.message || error}`);
    } finally {
      processing.delete(id);
    }
  }

  async function sweep() {
    const jobs = listScheduler().filter((item) => isDue(item));
    for (const item of jobs) {
      await executeItem(item);
    }
  }

  return {
    start() {
      if (timer) return timer;
      timer = setInterval(() => {
        sweep().catch((error) => {
          logger(`[Scheduler] Sweep failed: ${error?.message || error}`);
        });
      }, pollIntervalMs);
      if (typeof timer.unref === "function") timer.unref();
      return timer;
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    sweep,
  };
}

module.exports = {
  createSchedulerRuntime,
};
