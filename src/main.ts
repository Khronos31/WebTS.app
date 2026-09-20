// 0.1.0 の再実装はここから始める。現時点では起動して環境の前提が満たされているかを
// 表示するだけで、WebUSB にもチューナーにも触れない。
import { describeEnvironment } from './platform/environment';

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('app root missing');

const heading = document.createElement('h1');
heading.textContent = 'WebTS.app';
app.appendChild(heading);

const status = document.createElement('pre');
status.textContent = JSON.stringify(describeEnvironment(), null, 2);
app.appendChild(status);
