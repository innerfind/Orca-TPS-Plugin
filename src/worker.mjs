import { readTargetSession } from './data.mjs';
import { readActiveConversation } from './active-conversation.mjs';
import { createTpsController } from './controller.mjs';

let controller;

export default async function activate(orca) {
  controller?.stop();
  controller = createTpsController(orca, { readSession: readTargetSession, readActive: readActiveConversation });
  await controller.start({ background: true });
}

export function deactivate() {
  controller?.stop();
  controller = undefined;
}
