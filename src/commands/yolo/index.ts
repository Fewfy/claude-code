import type { Command } from '../../commands.js'

const yolo = {
  type: 'local-jsx',
  name: 'YOLO',
  aliases: ['yolo'],
  description: 'Enable bypass-permissions (YOLO) mode for this session',
  immediate: true,
  isEnabled: () => true,
  load: () => import('./yolo.js'),
} satisfies Command

export default yolo
