// USD per 1M tokens. Approximate — for a rough cost estimate only, not billing.
// Update as Anthropic pricing changes (verified against the claude-api skill's
// pricing table as of 2026-08-21; Sonnet 5 intro pricing $2/$10 expires 2026-08-31,
// this table already uses the post-intro standard rate).
const PRICING = {
  'claude-fable-5': { input: 10.0, output: 50.0 },
  'claude-mythos-5': { input: 10.0, output: 50.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};
const DEFAULT_PRICING = { input: 3.0, output: 15.0 };
const CACHE_WRITE_MULTIPLIER = 1.25; // approx 5-min ephemeral cache write vs base input
const CACHE_READ_MULTIPLIER = 0.1; // approx cache read vs base input

// usageByModel: Map<model, {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}>
function estimateCostUsd(usageByModel) {
  let total = 0;
  for (const [model, u] of usageByModel.entries()) {
    const rate = PRICING[model] || DEFAULT_PRICING;
    const perTokenIn = rate.input / 1_000_000;
    const perTokenOut = rate.output / 1_000_000;
    total += (u.input_tokens || 0) * perTokenIn;
    total += (u.cache_creation_input_tokens || 0) * perTokenIn * CACHE_WRITE_MULTIPLIER;
    total += (u.cache_read_input_tokens || 0) * perTokenIn * CACHE_READ_MULTIPLIER;
    total += (u.output_tokens || 0) * perTokenOut;
  }
  return total;
}

module.exports = { estimateCostUsd };
