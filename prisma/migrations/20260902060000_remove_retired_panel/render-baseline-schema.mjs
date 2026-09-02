import fs from 'node:fs';

const [sourcePath, destinationPath] = process.argv.slice(2);
if (!sourcePath || !destinationPath) {
  throw new Error('Usage: render-baseline-schema.mjs <source> <destination>');
}

const currentSchema = fs.readFileSync(sourcePath, 'utf8');
const legacyField = '  xpanelUserId    String?\n';
const fieldAnchor = '  avatarUrl       String?\n';
const currentTableMapping = '  @@map("server_configs")';
const legacyTableMapping = '  @@map("xpanel_configs")';

if (!currentSchema.includes(fieldAnchor) || !currentSchema.includes(currentTableMapping)) {
  throw new Error('The current schema no longer matches the expected migration input');
}

const baselineSchema = currentSchema
  .replace(fieldAnchor, fieldAnchor + legacyField)
  .replace(currentTableMapping, legacyTableMapping);

fs.writeFileSync(destinationPath, baselineSchema);
