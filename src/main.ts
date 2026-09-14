/**
 * WebTS.app M0 Entry Point
 * License: GPL-2.0-only
 */

import './styles/app.css';
import { UIController } from './ui/controller';

function initApp(): void {
  const root = document.getElementById('app');
  if (!root) {
    throw new Error('Application root element #app not found');
  }
  const controller = new UIController(root);
  controller.init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
