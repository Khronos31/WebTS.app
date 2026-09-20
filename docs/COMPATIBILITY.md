# Compatibility matrix

WebUSBはブラウザ、OS、USB driver bindingの組合せに依存するため、「Web対応」の一語で
扱わない。未検証欄を推測で埋めない。

| Device | OS | Browser/version | Driver binding | Select/open | Claim | Re-enumerate | 30 min TS | Card | Notes |
|---|---|---|---|---|---|---|---|---|---|
| PX-S1UD | Windows 11 Pro Insider Preview build 26220 | Google Chrome（正確なversion未取得） | provider: libwdi、version 6.1.7600.16385（binding方式は未確認、検証中に変更なし） | 成功 | Interface #0 成功 | 物理切断を検出し、再接続後の新規session成功。firmware/mode前後は未検証 | 未検証 | N/A | `3275:0080` |
| PX-Q3U4 | Windows 11 Pro Insider Preview build 26220 | Google Chrome（正確なversion未取得） | WinUSB（provider: libwdi、version 6.1.7600.16385） | 成功 | Interface #0 成功 | 物理切断を検出し、再接続後の新規session成功 | 未検証 | 未検証 | `0511:084a`。chooserに同一機種の2候補を確認 |

検証記録にはOSとブラウザの正確なバージョン、USB VID/PID、interface/endpoint、必要だった
driver binding変更、切断復帰結果を含める。カード番号や放送payloadは含めない。

## PX-S1UD Windows M0 observation

- `3275:0080`を利用者操作で選択した。Configuration #1がactiveだったが、
  `selectConfiguration()`を明示実行する必要はなかった。
- 表示されたInterfaceは#0のみで、Alternate #0、class `0xff`（Vendor Specific）、
  subclass `0xff`、protocol `0xff`だった。endpointは`#1` IN bulk 512Bと
  `#2` OUT bulk 512Bだった。
- select、open、Interface #0のclaim、release、closeが成功した。
- claim中の物理切断で`OPENED -> DISCONNECTED`と`DISCONNECT`を観測した。
  再接続後に新しいsessionでselect、open、claim、release、closeが成功した。
- この観測中にdriver bindingは変更していない。Windowsのsigned-driver情報では
  provider `libwdi`、version `6.1.7600.16385`だったが、binding方式は未確認。
  firmware/modeは適用しておらず、その前後の再列挙・VID:PID変化・権限挙動も未検証。
- 終了時は全interfaceをreleaseし、deviceをcloseした。Chromeの正確なversionは未取得。

## PX-Q3U4 Windows M0 observation

- WebUSB chooserには区別可能なPLEX PX-Q3U4が2件表示された。識別値は記録していないため、
  各chooser行とWindows上の2つのdevice instanceを事後に一意対応付けすることはできない。
- 両候補ともConfiguration #1、Interface #0、Alternate #0で、interface classは
  `0xff`（Vendor Specific）、subclassとprotocolは`0x00`だった。
- 両候補のendpointは同一で、`#1` IN bulk 512B、`#2` OUT bulk 512B、
  `#4` IN bulk 512B、`#5` IN bulk 512Bだった。
- 両候補でselect、open、Interface #0のclaim、release、closeが成功した。
- claim中の物理切断で`OPENED -> DISCONNECTED`を観測し、再接続後は新しいsessionで
  select、open、claim、release、closeが成功した。
- この観測中にdriver bindingは変更していない。終了時は全interfaceをreleaseし、
  全deviceをcloseした。
- Chromeの正確なversionが未取得のため、M0のversion記録要件は未完了である。
