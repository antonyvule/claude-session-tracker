const startedAt = Date.now();
const state = {
  lastPollAt: null,
  lastPollOk: null,
  lastPollError: null,
};

function recordPoll({ ok, error }) {
  state.lastPollAt = Date.now();
  state.lastPollOk = ok;
  state.lastPollError = error || null;
}

function handler(req, res) {
  res.json({
    ok: true,
    uptimeMs: Date.now() - startedAt,
    ...state,
  });
}

module.exports = { recordPoll, handler };
