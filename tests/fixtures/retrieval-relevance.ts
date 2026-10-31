export const retrievalRelevanceCases = [
  { query: "calculateTotal", expectedTop: "calculateTotal", relevant: ["calculateTotal"] },
  { query: "calculate average", expectedTop: "calculateAverage", relevant: ["calculateAverage"] },
  { query: "participant registration", expectedTop: "registerParticipant", relevant: ["registerParticipant"] },
] as const;
