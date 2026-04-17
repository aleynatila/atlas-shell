const fs = require("fs");
const path = require("path");
const data = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "SolarPutty_sessions_decrypted.txt"),
    "utf8",
  ),
);

const ATLAS_NEONS = ["#00E5FF", "#BD00FF", "#00FF88", "#FFD700", "#FF3860"];
const uniqueColors = [
  ...new Set(data.Sessions.map((s) => s.Color).filter(Boolean)),
];
const colorMap = {};
uniqueColors.forEach((c, i) => {
  colorMap[c] = ATLAS_NEONS[i % ATLAS_NEONS.length];
});

const credentials = (data.Credentials || [])
  .filter((c) => c.Username)
  .map((c) => ({
    id: c.Id,
    label: c.CredentialsName || c.Username,
    user: c.Username,
    pass: c.Password || undefined,
    keyPath: c.PrivateKeyPath || undefined,
  }));

const credMap = new Map(credentials.map((c) => [c.id, c]));

const sessions = data.Sessions.filter(
  (s) => s.ConnectionType === 1 && s.Ip,
).map((s) => {
  const cred = s.CredentialsID ? credMap.get(s.CredentialsID) : null;
  return {
    id: s.Id,
    label: s.SessionName,
    host: s.Ip,
    port: s.Port || 22,
    user: cred ? cred.user : "root",
    color: s.Color ? colorMap[s.Color] || ATLAS_NEONS[0] : ATLAS_NEONS[0],
    credentialId:
      s.CredentialsID && credMap.has(s.CredentialsID)
        ? s.CredentialsID
        : undefined,
  };
});

const snippet = [
  "localStorage.setItem('atlas_sessions', JSON.stringify(" +
    JSON.stringify(sessions) +
    "));",
  "localStorage.setItem('atlas_credentials', JSON.stringify(" +
    JSON.stringify(credentials) +
    "));",
  "console.log('Done: " +
    sessions.length +
    " sessions, " +
    credentials.length +
    " credentials');",
].join("\n");

fs.writeFileSync(path.join(__dirname, "seed_localstorage.js"), snippet);
console.log("sessions:", sessions.length, "| credentials:", credentials.length);
console.log("Written: seed_localstorage.js");
