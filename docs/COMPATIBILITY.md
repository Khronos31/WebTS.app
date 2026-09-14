# Compatibility matrix

WebUSBはブラウザ、OS、USB driver bindingの組合せに依存するため、「Web対応」の一語で
扱わない。未検証欄を推測で埋めない。

| Device | OS | Browser/version | Driver binding | Select/open | Claim | Re-enumerate | 30 min TS | Card | Notes |
|---|---|---|---|---|---|---|---|---|---|
| PX-S1UD | Windows 11 | Google Chrome（version未記録） | 未検証 | 未検証 | 未検証 | 未検証 | 未検証 | N/A | 最初の検証対象 |
| PX-Q3U4 | Windows 11 | Google Chrome（version未記録） | 未検証 | 未検証 | 未検証 | N/A | 未検証 | 未検証 | 最初の検証対象 |

検証記録にはOSとブラウザの正確なバージョン、USB VID/PID、interface/endpoint、必要だった
driver binding変更、切断復帰結果を含める。カード番号や放送payloadは含めない。
