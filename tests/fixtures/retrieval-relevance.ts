export const retrievalRelevanceCases = [
  { query: "calculateTotal", expectedTop: "calculateTotal", relevant: ["calculateTotal"] },
  { query: "calculate average", expectedTop: "calculateAverage", relevant: ["calculateAverage"] },
  { query: "register participant", expectedTop: "registerParticipant", relevant: ["registerParticipant"] },
  { query: "remove participant", expectedTop: "removeParticipant", relevant: ["removeParticipant"] },
  { query: "validate registration", expectedTop: "validateRegistration", relevant: ["validateRegistration"] },
  { query: "save tournament", expectedTop: "saveTournament", relevant: ["saveTournament"] },
  { query: "load tournament", expectedTop: "loadTournament", relevant: ["loadTournament"] },
  { query: "calculate standings", expectedTop: "calculateStandings", relevant: ["calculateStandings"] },
  { query: "parse tournament date", expectedTop: "parseTournamentDate", relevant: ["parseTournamentDate"] },
  { query: "determine winner", expectedTop: "determineWinner", relevant: ["determineWinner"] },
] as const;