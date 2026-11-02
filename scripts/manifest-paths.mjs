/** Commands in an oclif manifest whose path is not built JavaScript under dist/, as [command id, path]. */
export function sourcePaths(manifest) {
  return Object.entries(manifest.commands ?? {})
    .map(([id, command]) => [id, (command.relativePath ?? []).join('/')])
    .filter(([, path]) => !(path.startsWith('dist/') && path.endsWith('.js')));
}
