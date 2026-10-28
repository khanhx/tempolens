import './styles/tokens.css';
import './styles/base.css';
import { render } from 'preact';

const root = document.getElementById('app');
if (!root) throw new Error('Tempolens: #app element missing from index.html');
render(<p>Tempolens</p>, root);
