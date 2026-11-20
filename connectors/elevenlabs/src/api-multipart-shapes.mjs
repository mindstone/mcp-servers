// One shape check is shared by catalogue generation and loading.
export function binaryFileShape(schema, resolve = value => value) {
  schema = resolve(schema);
  if (!schema || typeof schema !== 'object') return undefined;
  if (schema.type === 'string' && schema.format === 'binary') return { multiple: false, nullable: false };
  if (schema.type === 'array') {
    const item = binaryFileShape(schema.items, resolve);
    return item && !item.multiple && !item.nullable ? { multiple: true, nullable: false } : undefined;
  }
  const branches = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(branches) || branches.length !== 2) return undefined;
  const other = branches.filter(branch => resolve(branch)?.type !== 'null');
  if (other.length !== 1) return undefined;
  const shape = binaryFileShape(other[0], resolve);
  return shape ? { ...shape, nullable: true } : undefined;
}
export function multipartFieldEncoding(schema, resolve = value => value) {
  schema = resolve(schema);
  const branches = schema?.anyOf ?? schema?.oneOf;
  if (Array.isArray(branches)) {
    const modes = branches.filter(branch => resolve(branch)?.type !== 'null').map(branch => multipartFieldEncoding(branch, resolve));
    if (modes.includes('repeated') && modes.every(mode => ['scalar', 'repeated'].includes(mode))) return 'repeated';
    return modes.every(mode => mode === modes[0]) ? modes[0] : 'json';
  }
  if (schema?.type === 'array') return multipartFieldEncoding(schema.items, resolve) === 'scalar' ? 'repeated' : 'json';
  return ['string', 'number', 'integer', 'boolean', 'null'].includes(schema?.type) ? 'scalar' : 'json';
}
