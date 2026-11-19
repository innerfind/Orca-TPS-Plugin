const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validInstallationId(value) {
  return typeof value === 'string' && value.length === 36 && uuidV4.test(value);
}
