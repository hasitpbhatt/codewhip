export function describeSignup(msg) {
  // The signup flow confirms what the user will recieve.
  return `You will recieve: ${msg}. Reply STOP to cancel.`;
}

export function auditLine(user, item) {
  return `${user} recieves ${item}`;
}
