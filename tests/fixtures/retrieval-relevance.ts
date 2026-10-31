export const retrievalRelevanceCases = [
  { query: "calculateTotal", expectedTop: "calculateTotal", relevant: ["calculateTotal"] },
  { query: "calculate average", expectedTop: "calculateAverage", relevant: ["calculateAverage", "calculateTotal"] },
  { query: "register participant", expectedTop: "registerParticipant", relevant: ["registerParticipant", "validateRegistration"] },
  { query: "remove participant", expectedTop: "removeParticipant", relevant: ["removeParticipant", "unregisterParticipant"] },
  { query: "validate registration", expectedTop: "validateRegistration", relevant: ["validateRegistration", "registerParticipant"] },
  { query: "save tournament", expectedTop: "saveTournament", relevant: ["saveTournament"] },
  { query: "load tournament", expectedTop: "loadTournament", relevant: ["loadTournament"] },
  { query: "calculate standings", expectedTop: "calculateStandings", relevant: ["calculateStandings", "determineWinner", "calculateTotal"] },
  { query: "parse tournament date", expectedTop: "parseTournamentDate", relevant: ["parseTournamentDate"] },
  { query: "determine winner", expectedTop: "determineWinner", relevant: ["determineWinner", "calculateStandings"] },
] as const;