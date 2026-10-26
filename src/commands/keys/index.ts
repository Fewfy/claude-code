import type { Command } from '../../commands.js'

const keys = {
  type: 'local-jsx',
  name: 'keys',
  aliases: ['key'],
  description:
    'Manage API key profiles (register keys and their available models)',
  immediate: true,
  isEnabled: () => true,
  argumentHint: '[list|add|use|remove|show]',
  load: () => import('./keys.js'),
} satisfies Command

export default keys
