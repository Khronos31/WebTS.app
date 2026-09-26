// PX4 系の筐体の組み立て。機種ごとの違いはこのファイルにだけ置く。
//
// 各機種の組み立ては上流 px4d（userland/tools/px4d.cpp）の run_q3u4 /
// run_w3u4 / run_mlt5pe / run_single_receiver と同じ部品を同じ順で組む。**IT930x の初期化を済ませてから
// 周りを組む**のも同じ（MLT5 系の LNB は初期化が GPIO 11 を確かめた後に
// 作る決まり。mlt5pe_power.h）。
//
// WebTS だけの違いは2つ。
//
// 1. IT930x の制御転送の間隔を no_delay にする。上流の既定は転送ごとに
//    sleep するが、Emscripten の main スレッドで sleep するとイベントループ
//    が止まる。WebUSB の往復だけで十分に間が空く（native/q3u4-version-probe.cpp）。
// 2. **PSB purger を渡さない。**px4d は取り込み開始のたびに TS の出口を一時的に
//    止めて1回読み、決まった量が読めることを確かめる（It930xController::
//    purge_psb。読めなければ TIMEOUT）。WebTS はデータプレーンがセッションの
//    あいだ同じ出口を読み続けているので、purge の読みが空になりうる。
//    purger を渡した版では、走査が地上波・BS・CS とも TIMEOUT (6) で失敗
//    した（実機、2026-09-25。視聴は通った）。0.2.0 までの WebTS は purger
//    なしで視聴も走査も実機で通っている。**purge が TIMEOUT の出どころだと
//    までは確かめていない。**
//
// どの組み立てを使うかは、機種の名前ではなく機種の表の形で決める（末尾の
// open_px4_enclosure）。上流が同じ形の機種を足せば、ここは触らなくてよい。
// 新しい形が出たときだけ、組み立てを1つ書く。

#include "px4-enclosure.h"

#include "mlt5pe_backend.h"
#include "mlt5pe_frontend.h"
#include "mlt5pe_power.h"
#include "q3u4_card_backend.h"
#include "q3u4_frontend.h"
#include "q3u4_lnb_power.h"
#include "q3u4_tuner_backend.h"
#include "single_receiver_frontend.h"

#include <chrono>
#include <new>
#include <optional>
#include <thread>

namespace webts {
namespace {

using namespace px4::userland;

// 組み立ても選局も pthread の上で行うので、ここでは待ってよい。
class Q3U4BlockingDelay final : public Q3U4FrontendDelay {
public:
    void sleep_ms(std::uint32_t milliseconds) noexcept override {
        std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
    }
};

class Mlt5PeBlockingDelay final : public Mlt5PeDelay {
public:
    void sleep_ms(std::uint32_t milliseconds) noexcept override {
        std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
    }
};

CommandPacingOptions pacing() noexcept {
    return CommandPacingOptions{CommandPacingMode::no_delay};
}

void report(Px4OpenProgress progress, void* context, Px4OpenStep step) noexcept {
    if (progress != nullptr) progress(context, step);
}

// ---- Q3 系：IT9305E が2つ、受信機8本（0/1/4/5 が衛星、2/3/6/7 が地上波）----
//
// PX-Q3U4、PX-Q3PE4、PX-Q3PE5。

class Q3U4Enclosure final : public Px4Enclosure {
public:
    explicit Q3U4Enclosure(Q3U4Runtime& runtime) noexcept
        : runtime_(runtime),
          dev1_(runtime.dev1(), pacing()),
          dev2_(runtime.dev2(), pacing())
    {
    }

    Result<void> open(const FirmwareImage& firmware, bool allow_15v,
                      Px4OpenProgress progress, void* context) noexcept {
        report(progress, context, Px4OpenStep::initialize);
        const auto initialized1 = dev1_.initialize_q3u4(firmware);
        if (!initialized1) return Result<void>::failure(initialized1.error());
        const auto initialized2 = dev2_.initialize_q3u4(firmware);
        if (!initialized2) return Result<void>::failure(initialized2.error());

        dev1_i2c_.emplace(dev1_);
        dev2_i2c_.emplace(dev2_);
        dev1_power_.emplace(dev1_);
        dev2_power_.emplace(dev2_);
        // purger は渡さない（先頭の説明）。
        frontend_.emplace(*dev1_i2c_, *dev2_i2c_, *dev1_power_, *dev2_power_, delay_);
        card_.emplace(dev1_, *frontend_);
        dev1_lnb_.emplace(dev1_);
        dev2_lnb_.emplace(dev2_);
        lnb_.emplace(*dev1_lnb_, *dev2_lnb_, allow_15v);
        tuner_.emplace(*frontend_, *lnb_);

        report(progress, context, Px4OpenStep::data_plane);
        auto plane = Q3U4StreamDataPlane::create(runtime_.dev1(), runtime_.dev2());
        if (!plane) return Result<void>::failure(plane.error());
        plane_ = std::move(plane.value());
        return Result<void>::success();
    }

    DeviceModel model() const noexcept override { return runtime_.model(); }
    TunerServiceBackend& tuner() noexcept override { return *tuner_; }
    CardServiceBackend& card_backend() noexcept override { return *card_; }
    It930xController& card_bridge() noexcept override { return dev1_; }
    Q3U4StreamDataPlane& plane() noexcept override { return *plane_; }

    void shutdown() noexcept override {
        // 保留中の bulk 転送のキャンセルを伴う停止。
        if (plane_) plane_->shutdown();
        if (tuner_.has_value()) (void)tuner_->shutdown();
    }

private:
    Q3U4Runtime& runtime_;
    Q3U4BlockingDelay delay_;
    It930xController dev1_;
    It930xController dev2_;
    std::optional<It930xBridgeI2cMaster> dev1_i2c_;
    std::optional<It930xBridgeI2cMaster> dev2_i2c_;
    std::optional<It930xBackendPower> dev1_power_;
    std::optional<It930xBackendPower> dev2_power_;
    std::optional<Q3U4FrontendEnclosure> frontend_;
    std::optional<Q3U4CardBackend> card_;
    std::optional<It930xLnbPower> dev1_lnb_;
    std::optional<It930xLnbPower> dev2_lnb_;
    std::optional<Q3U4LnbPowerCoordinator> lnb_;
    std::optional<Q3U4FrontendTunerBackend> tuner_;
    std::unique_ptr<Q3U4StreamDataPlane> plane_;
};

// ---- W3 系：PX-Q3U4 の片側のブリッジ1つ、受信機4本（0/1 が衛星、2/3 が地上波）----
//
// PX-W3U4、PX-W3PE4、PX-W3PE5。
//
// **上流では組み立ても backend も px4d の中にしか無い**（userland/tools/
// px4d.cpp の AbsentBridgePower、W3U4TunerBackend、run_w3u4。v0.1.5-beta、
// commit e71d22a。v0.1.6 でも書式のほかは同じ）。tools/ は同梱していないので、同じ内容をここに写した。
// 上流でも実機では確かめていない（Beta）。

// 2つ目のブリッジが無い。Q3U4 の電源の調停は2つを前提にしているので、
// 無いほうは USB に書かずに成功を返す。
class AbsentBridgePower final : public Q3U4BackendPower {
public:
    Result<void> set_backend_power(bool, Q3U4Delay&) noexcept override {
        return Result<void>::success();
    }
};

// 受信機の数と、どの受信機がどの波かだけを W3U4 に合わせ、残りは Q3U4 の
// backend にそのまま渡す。
class W3U4TunerBackend final : public TunerServiceBackend {
public:
    W3U4TunerBackend(Q3U4FrontendEnclosure& enclosure,
                     Q3U4LnbPowerCoordinator& lnb_power) noexcept
        : inner_(enclosure, lnb_power)
    {
    }

    std::uint8_t receiver_count() const noexcept override { return ipc::kW3U4ReceiverCount; }
    bool receiver_supports(std::uint8_t receiver, ipc::System system) const noexcept override {
        if (receiver >= ipc::kW3U4ReceiverCount) return false;
        const bool satellite = receiver < 2U;
        return system == (satellite ? ipc::System::ISDB_S : ipc::System::ISDB_T);
    }
    bool requires_terrestrial_lock_settle() const noexcept override { return true; }

    Result<void> open_receiver(std::uint8_t receiver) noexcept override {
        return inner_.open_receiver(receiver);
    }
    Result<void> tune_terrestrial(std::uint8_t receiver, std::uint32_t frequency_khz,
                                  std::uint32_t timeout_ms) noexcept override {
        return inner_.tune_terrestrial(receiver, frequency_khz, timeout_ms);
    }
    Result<void> tune_satellite(std::uint8_t receiver, std::uint32_t frequency_khz,
                                std::uint32_t timeout_ms) noexcept override {
        return inner_.tune_satellite(receiver, frequency_khz, timeout_ms);
    }
    Result<bool> is_locked(std::uint8_t receiver, ipc::System system) noexcept override {
        return inner_.is_locked(receiver, system);
    }
    Result<void> select_satellite_slot(std::uint8_t receiver, std::uint8_t slot,
                                       std::uint32_t timeout_ms) noexcept override {
        return inner_.select_satellite_slot(receiver, slot, timeout_ms);
    }
    Result<void> select_satellite_tsid(std::uint8_t receiver, std::uint16_t tsid,
                                       std::uint32_t timeout_ms) noexcept override {
        return inner_.select_satellite_tsid(receiver, tsid, timeout_ms);
    }
    Result<void> close_receiver(std::uint8_t receiver) noexcept override {
        return inner_.close_receiver(receiver);
    }
    Result<void> start_capture(std::uint8_t receiver, ipc::System system) noexcept override {
        return inner_.start_capture(receiver, system);
    }
    Result<void> stop_capture(std::uint8_t receiver, ipc::System system) noexcept override {
        return inner_.stop_capture(receiver, system);
    }
    Result<void> begin_tune_power(std::uint8_t receiver, ipc::System system,
                                  std::uint8_t lnb_voltage) noexcept override {
        return inner_.begin_tune_power(receiver, system, lnb_voltage);
    }
    Result<void> commit_tune_power(std::uint8_t receiver) noexcept override {
        return inner_.commit_tune_power(receiver);
    }
    Result<void> rollback_tune_power(std::uint8_t receiver) noexcept override {
        return inner_.rollback_tune_power(receiver);
    }
    void mark_receiver_disconnected(std::uint8_t receiver) noexcept override {
        inner_.mark_receiver_disconnected(receiver);
    }
    Result<void> shutdown() noexcept override { return inner_.shutdown(); }

private:
    Q3U4FrontendTunerBackend inner_;
};

class W3U4Enclosure final : public Px4Enclosure {
public:
    explicit W3U4Enclosure(Q3U4Runtime& runtime) noexcept
        : runtime_(runtime), device_(runtime.dev1(), pacing())
    {
    }

    Result<void> open(const FirmwareImage& firmware, bool allow_15v,
                      Px4OpenProgress progress, void* context) noexcept {
        report(progress, context, Px4OpenStep::initialize);
        // ファームウェアも初期化も PX-Q3U4 と同じ（2,169 バイト）。
        const auto initialized = device_.initialize_q3u4(firmware);
        if (!initialized) return Result<void>::failure(initialized.error());

        // 2つ目のブリッジの口には、同じ I2C と「無い」電源を渡す（px4d と同じ）。
        i2c_.emplace(device_);
        power_.emplace(device_);
        // purger は渡さない（先頭の説明）。
        frontend_.emplace(*i2c_, *i2c_, *power_, absent_power_, delay_);
        card_.emplace(device_, *frontend_);
        lnb_power_.emplace(device_);
        lnb_.emplace(*lnb_power_, *lnb_power_, allow_15v);
        tuner_.emplace(*frontend_, *lnb_);

        report(progress, context, Px4OpenStep::data_plane);
        auto plane = Q3U4StreamDataPlane::create_w3u4(runtime_.dev1());
        if (!plane) return Result<void>::failure(plane.error());
        plane_ = std::move(plane.value());
        return Result<void>::success();
    }

    DeviceModel model() const noexcept override { return runtime_.model(); }
    TunerServiceBackend& tuner() noexcept override { return *tuner_; }
    CardServiceBackend& card_backend() noexcept override { return *card_; }
    It930xController& card_bridge() noexcept override { return device_; }
    Q3U4StreamDataPlane& plane() noexcept override { return *plane_; }

    void shutdown() noexcept override {
        if (plane_) plane_->shutdown();
        if (tuner_.has_value()) (void)tuner_->shutdown();
    }

private:
    Q3U4Runtime& runtime_;
    Q3U4BlockingDelay delay_;
    AbsentBridgePower absent_power_;
    It930xController device_;
    std::optional<It930xBridgeI2cMaster> i2c_;
    std::optional<It930xBackendPower> power_;
    std::optional<Q3U4FrontendEnclosure> frontend_;
    std::optional<Q3U4CardBackend> card_;
    std::optional<It930xLnbPower> lnb_power_;
    std::optional<Q3U4LnbPowerCoordinator> lnb_;
    std::optional<W3U4TunerBackend> tuner_;
    std::unique_ptr<Q3U4StreamDataPlane> plane_;
};

// ---- MLT 系：IT930x が1つ、受信機3〜5本（どれも地上波と衛星を切り替え）----
//
// PX-MLT5PE、DTV02A-5TS-P、PX-MLT8PE3、PX-MLT8PE5、DTV02A-4TS-P。受信機の数と
// 配線は機種で違うが、上流の frontend・backend・データプレーンが機種を受け取って
// 引き分ける（px4d の run_mlt5pe と同じ引数）。

class MltFamilyEnclosure final : public Px4Enclosure {
public:
    explicit MltFamilyEnclosure(Q3U4Runtime& runtime) noexcept
        : runtime_(runtime), device_(runtime.dev1(), pacing())
    {
    }

    Result<void> open(const FirmwareImage& firmware, bool allow_15v,
                      Px4OpenProgress progress, void* context) noexcept {
        const DeviceModel model = runtime_.model();
        const DeviceProfile& profile = device_profile(model);
        report(progress, context, Px4OpenStep::initialize);
        const auto initialized = device_.initialize_mlt_family(firmware, model);
        if (!initialized) return Result<void>::failure(initialized.error());

        bus1_.emplace(device_, std::uint8_t{1U});
        bus3_.emplace(device_, std::uint8_t{3U});
        power_.emplace(device_);
        // purger は渡さない（先頭の説明）。
        frontend_.emplace(*bus1_, *bus3_, *power_, delay_, nullptr,
                          profile.receiver_count, model);
        card_.emplace(device_, *frontend_);
        lnb_power_.emplace(device_);
        lnb_.emplace(*lnb_power_, allow_15v);
        tuner_.emplace(*frontend_, *lnb_, profile.receiver_count, profile.dual_system, model);

        report(progress, context, Px4OpenStep::data_plane);
        auto plane = Q3U4StreamDataPlane::create_mlt_family(runtime_.dev1(), model);
        if (!plane) return Result<void>::failure(plane.error());
        plane_ = std::move(plane.value());
        return Result<void>::success();
    }

    DeviceModel model() const noexcept override { return runtime_.model(); }
    TunerServiceBackend& tuner() noexcept override { return *tuner_; }
    CardServiceBackend& card_backend() noexcept override { return *card_; }
    It930xController& card_bridge() noexcept override { return device_; }
    Q3U4StreamDataPlane& plane() noexcept override { return *plane_; }

    void shutdown() noexcept override {
        if (plane_) plane_->shutdown();
        if (tuner_.has_value()) (void)tuner_->shutdown();
    }

private:
    Q3U4Runtime& runtime_;
    Mlt5PeBlockingDelay delay_;
    It930xController device_;
    std::optional<It930xBridgeI2cMaster> bus1_;
    std::optional<It930xBridgeI2cMaster> bus3_;
    std::optional<It930xBackendPower> power_;
    std::optional<Mlt5PeFrontend> frontend_;
    std::optional<Mlt5PeCardBackend> card_;
    std::optional<It930xLnbPower> lnb_power_;
    std::optional<Mlt5PeLnbPowerCoordinator> lnb_;
    std::optional<Mlt5PeTunerBackend> tuner_;
    std::unique_ptr<Q3U4StreamDataPlane> plane_;
};

// ---- 1受信機：IT930x が1つ、受信機1本 ----
//
// PX-M1UR、DTV02-1T1S-U、DTV02A-1T1S-U（地上波と衛星を切り替え）と、PX-S1UR、
// DTV03A-1TU（地上波だけ）。frontend が選局とカードの両方の backend を兼ねる。
//
// **電源の口は上流では px4d の中にしか無い**（userland/tools/px4d.cpp の
// It930xSingleReceiverPower、run_single_receiver。v0.1.6、commit 3477301）。
// 同じ内容をここに写した。上流でも実機では確かめていない。

class It930xSingleReceiverPower final : public Q3U4BackendPower {
public:
    explicit It930xSingleReceiverPower(It930xController& controller) noexcept
        : controller_(controller)
    {
    }
    Result<void> set_backend_power(bool on, Q3U4Delay& delay) noexcept override {
        return controller_.set_single_receiver_backend_power(on, delay);
    }

private:
    It930xController& controller_;
};

class SingleReceiverEnclosure final : public Px4Enclosure {
public:
    explicit SingleReceiverEnclosure(Q3U4Runtime& runtime) noexcept
        : runtime_(runtime), device_(runtime.dev1(), pacing())
    {
    }

    Result<void> open(const FirmwareImage& firmware, bool allow_15v,
                      Px4OpenProgress progress, void* context) noexcept {
        const DeviceModel model = runtime_.model();
        report(progress, context, Px4OpenStep::initialize);
        const auto initialized = device_.initialize_single_receiver(firmware, model);
        if (!initialized) return Result<void>::failure(initialized.error());

        bridge_.emplace(device_, std::uint8_t{3U});
        power_.emplace(device_);
        frontend_.emplace(*bridge_, device_, *power_, delay_, model, allow_15v);

        report(progress, context, Px4OpenStep::data_plane);
        auto plane = Q3U4StreamDataPlane::create_single_receiver(runtime_.dev1(), model);
        if (!plane) return Result<void>::failure(plane.error());
        plane_ = std::move(plane.value());
        return Result<void>::success();
    }

    DeviceModel model() const noexcept override { return runtime_.model(); }
    TunerServiceBackend& tuner() noexcept override { return *frontend_; }
    CardServiceBackend& card_backend() noexcept override { return *frontend_; }
    It930xController& card_bridge() noexcept override { return device_; }
    Q3U4StreamDataPlane& plane() noexcept override { return *plane_; }

    void shutdown() noexcept override {
        if (plane_) plane_->shutdown();
        if (frontend_.has_value()) (void)frontend_->shutdown();
    }

private:
    Q3U4Runtime& runtime_;
    Q3U4BlockingDelay delay_;
    It930xController device_;
    std::optional<It930xBridgeI2cMaster> bridge_;
    std::optional<It930xSingleReceiverPower> power_;
    std::optional<SingleReceiverFrontend> frontend_;
    std::unique_ptr<Q3U4StreamDataPlane> plane_;
};

// ---- 組み立ての選び方 ----

template <typename Enclosure>
Result<std::unique_ptr<Px4Enclosure>> build(Q3U4Runtime& runtime, const FirmwareImage& firmware,
                                            bool allow_15v, Px4OpenProgress progress,
                                            void* context) noexcept {
    auto enclosure = std::unique_ptr<Enclosure>(new (std::nothrow) Enclosure(runtime));
    if (!enclosure) return Result<std::unique_ptr<Px4Enclosure>>::failure(Error::INTERNAL);
    const auto opened = enclosure->open(firmware, allow_15v, progress, context);
    if (!opened) {
        enclosure->shutdown();
        return Result<std::unique_ptr<Px4Enclosure>>::failure(opened.error());
    }
    return Result<std::unique_ptr<Px4Enclosure>>::success(std::move(enclosure));
}

}  // namespace

// **機種の名前では選ばない。**上流 px4d の main と同じく、機種の表の形
// （USB 機器の数、受信機の数、受信機ごとに波を切り替えられるか）で選ぶ。
// 上流が同じ形の機種を足せば、ここを触らずに開ける。
Result<std::unique_ptr<Px4Enclosure>> open_px4_enclosure(
    Q3U4Runtime& runtime, const FirmwareImage& firmware, bool allow_15v,
    Px4OpenProgress progress, void* progress_context) noexcept {
    const DeviceProfile& profile = device_profile(runtime.model());
    if (profile.bridge_count == 1U && !profile.dual_system &&
        profile.receiver_count == ipc::kW3U4ReceiverCount) {
        return build<W3U4Enclosure>(runtime, firmware, allow_15v, progress, progress_context);
    }
    if (profile.bridge_count == 2U) {
        return build<Q3U4Enclosure>(runtime, firmware, allow_15v, progress, progress_context);
    }
    if (profile.receiver_count == 1U) {
        return build<SingleReceiverEnclosure>(runtime, firmware, allow_15v, progress,
                                              progress_context);
    }
    return build<MltFamilyEnclosure>(runtime, firmware, allow_15v, progress, progress_context);
}

}  // namespace webts
