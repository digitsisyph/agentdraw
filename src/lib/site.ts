/** Facts about this deployment that the UI, llms.txt, and docs all share. */
export const SITE_URL = 'https://agentdraw.app';

/** What a person pastes into an agent app to get an agent onto the board. */
export const BOOTSTRAP_PROMPT =
  'Open https://agentdraw.app in your built-in browser and keep it open so we can work on the board together. It is a whiteboard you can draw on.';

/** Requests that work well once the agent is on the board. */
export const EXAMPLE_PROMPTS = [
  'Draw the sign-in flow: login form, home screen, and the arrow between them.',
  'Sketch a three-column kanban board with two cards in each column.',
  'Look at what I drew and turn it into a clean flowchart.',
];
