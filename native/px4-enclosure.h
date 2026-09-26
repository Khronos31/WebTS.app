// PX4 系の筐体を、機種を問わず同じ形で扱う。
//
// **機種ごとに違うのは組み立てだけにする。**上流の px4d は機種ごとに
// `run_q3u4` / `run_mlt5pe` で部品を組み、組んだ後は `TunerServiceBackend`
// と `CardServiceBackend` とデータプレーン越しにしか触らない。ここも同じで、
// 組み立ては px4-enclosure.cpp の機種の表に1つずつ置き、呼び出し側
// （q3u4-descramble-probe.cpp）は Px4Enclosure 越しにしか触らない。
//
// 機種を足すときは、px4-enclosure.cpp に組み立てを1つ足して表へ載せる。
// 受信機の数・各受信機が地上波と衛星のどちらを受けられるか・衛星の TS を
// 選ぶ順序は、上流の backend が答える。

#ifndef WEBTS_PX4_ENCLOSURE_H
#define WEBTS_PX4_ENCLOSURE_H

#include "px4/card_service.h"
#include "px4/firmware.h"
#include "px4/identity.h"
#include "px4/it930x.h"
#include "px4/libusb_transport.h"
#include "px4/q3u4_stream.h"
#include "px4/tuner_service.h"

#include <memory>

namespace webts {

class Px4Enclosure {
public:
    virtual ~Px4Enclosure() noexcept = default;

    virtual px4::userland::DeviceModel model() const noexcept = 0;
    /** 選局・ロック・TS の選択・取り込み・LNB 給電。受信機の能力もここが答える。 */
    virtual px4::userland::TunerServiceBackend& tuner() noexcept = 0;
    /** 内蔵カードの電源と UART。 */
    virtual px4::userland::CardServiceBackend& card_backend() noexcept = 0;
    /** カードの UART がつながっている IT930x。 */
    virtual px4::userland::It930xController& card_bridge() noexcept = 0;
    /** 受信機ごとの TS を束ねるデータプレーン。 */
    virtual px4::userland::Q3U4StreamDataPlane& plane() noexcept = 0;
    /** データプレーンを止め、LNB を落とす。USB に触れる。 */
    virtual void shutdown() noexcept = 0;
};

/** 組み立ての進み具合。呼び出し側が JS へ見せる。 */
enum class Px4OpenStep : int { initialize = 0, data_plane = 1 };
using Px4OpenProgress = void (*)(void* context, Px4OpenStep step) noexcept;

/**
 * 開いた筐体の機種に合わせて組み立て、初期化する。USB に触れる。
 * runtime は組み立てたものより長く生かすこと。
 */
px4::userland::Result<std::unique_ptr<Px4Enclosure>> open_px4_enclosure(
    px4::userland::Q3U4Runtime& runtime, const px4::userland::FirmwareImage& firmware,
    bool allow_15v, Px4OpenProgress progress, void* progress_context) noexcept;

}  // namespace webts

#endif  // WEBTS_PX4_ENCLOSURE_H
