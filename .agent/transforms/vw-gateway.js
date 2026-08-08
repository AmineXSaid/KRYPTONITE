// Reshapes requests for a gateway that wraps the OpenAI body in an envelope.
// Runs in a vm sandbox: JSON reshaping only, no fs, no network.
exports.transformRequest = (body, profile) => {
  const { model, ...rest } = body;
  return { deployment: model, requestId: Date.now().toString(36), payload: rest };
};
exports.transformResponse = (json) => {
  if (json.error) throw new Error(json.error.code + ": " + json.error.detail);
  return json.payload ?? json;
};
