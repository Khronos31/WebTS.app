// 表示する版。**package.json から読む。**
//
// 画面ごとに書き写していたので、package.json を 0.1.0 にしたあとも、
// ドロワーと About には 0.1.0-dev が残っていた。名前付きで読むので、
// 束ねられるのは version だけで、依存の一覧は配信物に入らない。

import { version } from '../../package.json';

export const APP_VERSION: string = version;
