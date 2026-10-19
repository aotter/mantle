import { connectHost } from "../admin/src/mcp-app/postmessage";
const inputs: unknown[] = [], results: unknown[] = [], contexts: unknown[] = [], errors: string[] = [];
const probe = { inputs, results, contexts, errors, cancelled: 0, call: undefined as unknown, close: () => {} };
probe.close = connectHost({
  ready: (host, context) => { probe.call = host.call; contexts.push(context); },
  input: value => { inputs.push(value); }, result: value => { results.push(value); },
  cancelled: () => { probe.cancelled++; }, context: value => { contexts.push(value); }, error: error => { errors.push(error.message); },
});
Object.assign(window, { probe });
