import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './components/shell/shell.css';
import { effect } from '@preact/signals';
import { render } from 'preact';
import { App } from './app';
import { loadMe } from './lib/me';
import { applyTheme, theme } from './lib/prefs';

// Applied before the first render; the CSP forbids an inline script in index.html.
effect(() => applyTheme(theme.value));
void loadMe();

const root = document.getElementById('app');
if (!root) throw new Error('Tempolens: #app element missing from index.html');
render(<App />, root);
