/**
 * WebTS.app M0 - UI Components (Framework-free DOM generators)
 * License: GPL-2.0-only
 */

import type {
  AdapterState,
  DiagnosticEntry,
  SanitizedConfigurationSummary,
  SanitizedDeviceSummary,
  SanitizedInterfaceSummary,
} from '../types/usb';

export function getStateLabelAndClass(state: AdapterState): { label: string; className: string } {
  switch (state) {
    case 'UNSUPPORTED':
      return { label: 'WebUSB未対応', className: 'unsupported' };
    case 'IDLE':
      return { label: '待機中 (デバイス未選択)', className: 'idle' };
    case 'DEVICE_SELECTED':
      return { label: 'デバイス選択済み (未オープン)', className: 'device_selected' };
    case 'OPENED_NO_CONFIG':
      return { label: 'オープン中 (コンフィギュレーション未選択)', className: 'opened_no_config' };
    case 'OPENED':
      return { label: 'オープン中 (接続完了)', className: 'opened' };
    case 'CLOSED':
      return { label: 'クローズ済み (完了)', className: 'closed' };
    case 'DISCONNECTED':
      return { label: '物理切断検出', className: 'disconnected' };
  }
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function createWindowsNoticeElement(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'notice-box warning';
  section.setAttribute('aria-label', 'Windowsドライバについての重要なお知らせ');
  section.innerHTML = `
    <strong>【Windows環境での注意】</strong><br>
    WebUSB経由でチューナーにアクセスするには、対象のインターフェイスにWinUSB等のドライババインディングが必要となる場合があります。ドライババインディングを変更すると、既存のネイティブTV視聴・録画ソフトウェアが一時的に利用できなくなる可能性があります。インターフェイス構成の精査とロールバック手順の確認が完了するまで、特定のドライバ変更ツールの実行は推奨されません。
  `;
  return section;
}

export function createUnsupportedNoticeElement(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'notice-box danger';
  section.setAttribute('role', 'alert');
  section.innerHTML = `
    <strong>【WebUSB API 未対応環境】</strong><br>
    現在のブラウザ環境では WebUSB API を利用できません。以下の要件を確認してください：
    <ul style="margin-top: 0.5rem; margin-left: 1.25rem;">
      <li>セキュアコンテキスト (HTTPS または http://localhost) であること</li>
      <li>Chromium系ブラウザ (Google Chrome, Microsoft Edge など) であること</li>
      <li>※ Firefox、Safari、iOS版ブラウザは仕様上 WebUSB に対応していません</li>
    </ul>
  `;
  return section;
}

export function createDeviceSummaryElement(
  summary: SanitizedDeviceSummary,
  claimedInterfaces: ReadonlySet<number>,
  callbacks: {
    onClaimInterface: (interfaceNumber: number) => void;
    onReleaseInterface: (interfaceNumber: number) => void;
    onSelectConfig: (configurationValue: number) => void;
  },
  isBusy = false,
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'card';
  card.setAttribute('aria-labelledby', 'summary-title');

  const title = document.createElement('h2');
  title.id = 'summary-title';
  title.className = 'card-title';
  title.innerHTML = `<span>📡</span> デバイス詳細: ${escapeHtml(summary.knownModelLabel)}`;
  card.appendChild(title);

  // Table summary
  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `
    <tbody>
      <tr>
        <th scope="row">機種名 / 状態</th>
        <td><strong>${escapeHtml(summary.knownModelLabel)}</strong></td>
      </tr>
      <tr>
        <th scope="row">USB VID:PID</th>
        <td><span class="code-font">${summary.vendorIdHex}:${summary.productIdHex}</span></td>
      </tr>
      ${summary.manufacturerName || summary.productName ? `
      <tr>
        <th scope="row">製造者 / 製品名</th>
        <td>${escapeHtml([summary.manufacturerName, summary.productName].filter(Boolean).join(' / '))}</td>
      </tr>
      ` : ''}
      <tr>
        <th scope="row">USB / Device バージョン</th>
        <td>USB v${escapeHtml(summary.usbVersion)} (デバイス v${escapeHtml(summary.deviceVersion)})</td>
      </tr>
      <tr>
        <th scope="row">デバイスクラス</th>
        <td>0x${summary.deviceClass.toString(16).padStart(2, '0')} (${escapeHtml(summary.deviceClassName)})</td>
      </tr>
      <tr>
        <th scope="row">接続・オープン状態</th>
        <td>${summary.opened ? '<span style="color: var(--color-success)">● オープン済み</span>' : '<span style="color: var(--text-muted)">○ 未オープン</span>'}</td>
      </tr>
      <tr>
        <th scope="row">アクティブ・コンフィギュレーション</th>
        <td>${summary.activeConfigurationValue !== null ? `#${summary.activeConfigurationValue}` : '<span style="color: var(--color-warning)">未設定</span>'}</td>
      </tr>
      <tr>
        <th scope="row">当セッション要求済みIF</th>
        <td>${claimedInterfaces.size > 0 ? Array.from(claimedInterfaces).map((n) => `<span class="code-font">IF #${n}</span>`).join(' ') : 'なし'}</td>
      </tr>
    </tbody>
  `;
  card.appendChild(table);

  // Configurations & Interfaces
  const descContainer = document.createElement('div');
  descContainer.className = 'descriptors-container';

  const descHeading = document.createElement('h3');
  descHeading.style.fontSize = '1rem';
  descHeading.style.marginTop = '0.5rem';
  descHeading.textContent = '構成記述子 (Configurations & Interfaces)';
  descContainer.appendChild(descHeading);

  summary.configurations.forEach((cfg: SanitizedConfigurationSummary) => {
    const configBlock = document.createElement('section');
    configBlock.className = 'config-block';

    const cfgHeader = document.createElement('div');
    cfgHeader.className = 'config-header';
    cfgHeader.innerHTML = `
      <div>
        <strong>Configuration #${cfg.configurationValue}</strong>
        ${cfg.configurationName ? `<span>(${escapeHtml(cfg.configurationName)})</span>` : ''}
        ${cfg.isSelected ? '<span class="status-badge opened" style="margin-left: 0.5rem;">選択中</span>' : ''}
      </div>
    `;

    if (summary.opened && !cfg.isSelected) {
      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'btn btn-secondary btn-sm';
      selectBtn.textContent = `Config #${cfg.configurationValue} を選択`;
      selectBtn.disabled = isBusy;
      selectBtn.addEventListener('click', () => callbacks.onSelectConfig(cfg.configurationValue));
      cfgHeader.appendChild(selectBtn);
    }

    configBlock.appendChild(cfgHeader);

    // Interfaces
    const ifaceList = document.createElement('div');
    ifaceList.className = 'interface-list';

    cfg.interfaces.forEach((iface: SanitizedInterfaceSummary) => {
      const isClaimedBySession = claimedInterfaces.has(iface.interfaceNumber);

      const ifaceCard = document.createElement('div');
      ifaceCard.className = `interface-card ${isClaimedBySession ? 'claimed' : ''}`;

      const ifHeader = document.createElement('div');
      ifHeader.className = 'interface-header';

      const ifTitle = document.createElement('div');
      ifTitle.innerHTML = `
        <strong>Interface #${iface.interfaceNumber}</strong>
        ${isClaimedBySession ? '<span class="status-badge opened" style="font-size: 0.75rem; margin-left: 0.5rem;">Claimed (要求済み)</span>' : ''}
      `;
      ifHeader.appendChild(ifTitle);

      // Claim / Release button if device is open
      if (summary.opened) {
        if (isClaimedBySession) {
          const releaseBtn = document.createElement('button');
          releaseBtn.type = 'button';
          releaseBtn.className = 'btn btn-secondary btn-sm';
          releaseBtn.textContent = `Release (解放)`;
          releaseBtn.disabled = isBusy;
          releaseBtn.addEventListener('click', () => callbacks.onReleaseInterface(iface.interfaceNumber));
          ifHeader.appendChild(releaseBtn);
        } else if (iface.isClaimable) {
          const claimBtn = document.createElement('button');
          claimBtn.type = 'button';
          claimBtn.className = 'btn btn-primary btn-sm';
          claimBtn.textContent = `Claim (要求)`;
          claimBtn.disabled = isBusy;
          claimBtn.addEventListener('click', () => callbacks.onClaimInterface(iface.interfaceNumber));
          ifHeader.appendChild(claimBtn);
        } else {
          const disabledBadge = document.createElement('span');
          disabledBadge.style.fontSize = '0.75rem';
          disabledBadge.style.color = 'var(--color-error)';
          disabledBadge.textContent = iface.claimDisallowedReason ?? '要求不可';
          ifHeader.appendChild(disabledBadge);
        }
      }

      ifaceCard.appendChild(ifHeader);

      // Alternates & Endpoints
      iface.alternates.forEach((alt) => {
        const altBox = document.createElement('div');
        altBox.className = 'alternate-box';
        altBox.innerHTML = `
          <div>
            <strong>Alt #${alt.alternateSetting}</strong>:
            Class 0x${alt.interfaceClass.toString(16).padStart(2, '0')} (${escapeHtml(alt.interfaceClassName)}),
            Subclass 0x${alt.interfaceSubclass.toString(16).padStart(2, '0')},
            Protocol 0x${alt.interfaceProtocol.toString(16).padStart(2, '0')}
            ${alt.interfaceName ? ` - <em>${escapeHtml(alt.interfaceName)}</em>` : ''}
          </div>
        `;

        if (alt.endpoints.length > 0) {
          const epList = document.createElement('div');
          epList.className = 'endpoints-list';
          alt.endpoints.forEach((ep) => {
            const epChip = document.createElement('span');
            epChip.className = 'endpoint-chip';
            epChip.textContent = `EP #${ep.endpointNumber} [${ep.direction.toUpperCase()}] ${ep.type} (${ep.packetSize}B)`;
            epList.appendChild(epChip);
          });
          altBox.appendChild(epList);
        } else {
          const noEp = document.createElement('div');
          noEp.style.fontSize = '0.75rem';
          noEp.style.color = 'var(--text-muted)';
          noEp.textContent = 'エンドポイントなし (Control Endpointのみ)';
          altBox.appendChild(noEp);
        }

        ifaceCard.appendChild(altBox);
      });

      ifaceList.appendChild(ifaceCard);
    });

    configBlock.appendChild(ifaceList);
    descContainer.appendChild(configBlock);
  });

  card.appendChild(descContainer);
  return card;
}

export function createDiagnosticsElement(
  logs: readonly DiagnosticEntry[],
  onClear: () => void,
): HTMLElement {
  const card = document.createElement('section');
  card.className = 'card';
  card.setAttribute('aria-labelledby', 'diag-title');

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';

  const title = document.createElement('h2');
  title.id = 'diag-title';
  title.className = 'card-title';
  title.style.border = 'none';
  title.style.padding = '0';
  title.innerHTML = `<span>📋</span> 診断イベントログ (${logs.length}件)`;
  header.appendChild(title);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-secondary btn-sm';
  clearBtn.textContent = 'ログ消去';
  clearBtn.addEventListener('click', onClear);
  header.appendChild(clearBtn);

  card.appendChild(header);

  const consoleBox = document.createElement('div');
  consoleBox.className = 'diagnostics-console';
  consoleBox.setAttribute('role', 'log');
  consoleBox.setAttribute('aria-live', 'polite');

  if (logs.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.color = 'var(--text-muted)';
    emptyMsg.textContent = 'ログはありません。';
    consoleBox.appendChild(emptyMsg);
  } else {
    // Show newest first or oldest first with auto-scroll
    logs.forEach((log) => {
      const item = document.createElement('div');
      item.className = 'diagnostic-item';

      const time = document.createElement('span');
      time.className = 'diag-time';
      time.textContent = `[${log.timestamp}]`;
      item.appendChild(time);

      const code = document.createElement('span');
      code.className = `diag-code ${log.code}`;
      code.textContent = log.code;
      item.appendChild(code);

      const msg = document.createElement('span');
      msg.className = 'diag-message';
      msg.textContent = log.message;
      item.appendChild(msg);

      consoleBox.appendChild(item);
    });
  }

  card.appendChild(consoleBox);
  return card;
}
