// Modified/ported for px4-userland on 2026-09-25.
// Derived from tsukumijima/px4_drv: driver/m1ur_device.c,
// driver/s1ur_device.c, driver/isdb2056_device.c.
// SPDX-License-Identifier: GPL-2.0-only
#include "single_receiver_frontend.h"

namespace px4::userland {
namespace {
Q3U4ReceiverMapping mapping(std::uint8_t address, bool secondary,
                            Tc90522System system) noexcept
{
    return Q3U4ReceiverMapping{0U, address, secondary, system};
}
}

SingleReceiverFrontend::SingleReceiverFrontend(
    BridgeI2cMaster& bridge, It930xController& controller, Q3U4BackendPower& power,
    Q3U4FrontendDelay& delay, DeviceModel model, bool allow_lnb_power) noexcept
    : controller_(controller), power_(power), delay_(delay), model_(model),
      allow_lnb_power_(allow_lnb_power),
      tc_t_(bridge, mapping(model == DeviceModel::dtv03a_1tu ? 0x18U : 0x10U,
                           false, Tc90522System::isdb_t)),
      tc_s_(bridge, mapping(model == DeviceModel::dtv02a_1t1s_u ? 0x13U : 0x11U,
                           model == DeviceModel::dtv02a_1t1s_u, Tc90522System::isdb_s)),
      tc_s0_(bridge, mapping(0x11U, false, Tc90522System::isdb_s)),
      r850_(tc_t_, delay, false), rt710_(tc_s_, delay)
{
}

SingleReceiverFrontend::~SingleReceiverFrontend() noexcept { (void)shutdown(); }

bool SingleReceiverFrontend::receiver_supports(std::uint8_t receiver,
                                                ipc::System system) const noexcept
{
    if (receiver != 0U) return false;
    const bool satellite = model_ == DeviceModel::px_m1ur ||
        model_ == DeviceModel::dtv02_1t1s_u || model_ == DeviceModel::dtv02a_1t1s_u;
    return system == ipc::System::ISDB_T || (satellite && system == ipc::System::ISDB_S);
}

Result<void> SingleReceiverFrontend::acquire_power() noexcept
{
    std::lock_guard<std::mutex> lock(power_mutex_);
    if (references_ == 0U) {
        const auto on = power_.set_backend_power(true, delay_);
        if (!on) return on;
        powered_ = true;
    }
    if (references_ != 0xffU) ++references_;
    return Result<void>::success();
}

Result<void> SingleReceiverFrontend::release_power() noexcept
{
    std::lock_guard<std::mutex> lock(power_mutex_);
    if (references_ == 0U) return Result<void>::success();
    --references_;
    if (references_ == 0U && powered_) {
        const auto off = power_.set_backend_power(false, delay_);
        if (!off) return off;
        powered_ = false;
    }
    return Result<void>::success();
}

Result<void> SingleReceiverFrontend::initialize_frontend() noexcept
{
    const bool has_satellite = receiver_supports(0U, ipc::System::ISDB_S);
    const auto t = tc_t_.write_reg(0xb0U, 0xa0U);
    if (!t) return t;
    constexpr std::uint8_t regs[]{0xb2U,0xb3U,0xb4U,0xb5U,0xb6U,0xb7U,0xb8U};
    constexpr std::uint8_t vals[]{0x3dU,0x25U,0x8bU,0x4bU,0x3fU,0xffU,0xc0U};
    for (std::size_t i=0;i<7U;++i) { const auto r=tc_t_.write_reg(regs[i],vals[i]); if(!r)return r; }
    if (model_ == DeviceModel::dtv03a_1tu) {
        constexpr std::uint8_t isdbt[][2]{{0x04,0x00},{0x10,0x00},{0x11,0x2d},{0x12,0x02},
            {0x13,0x62},{0x14,0x60},{0x15,0x00},{0x16,0x00},{0x1d,0x05},{0x1e,0x15},
            {0x1f,0x40},{0x30,0x20},{0x31,0x0b},{0x32,0x8f},{0x34,0x0f},{0x38,0x01},{0x39,0x1c}};
        for (const auto& row : isdbt) { const auto r=tc_t_.write_reg(row[0],row[1]); if(!r)return r; }
    }
    if (model_ == DeviceModel::px_m1ur || model_ == DeviceModel::dtv02_1t1s_u ||
        model_ == DeviceModel::dtv02a_1t1s_u) {
        const auto a=tc_s_.write_reg(0x15U,0U); if(!a)return a;
        const auto b=tc_s_.write_reg(0x1dU,0U); if(!b)return b;
    }
    if (has_satellite) { const auto rt=rt710_.initialize(); if(!rt)return rt; }
    const auto rf=r850_.initialize(); if(!rf){ (void)rt710_.terminate(); return rf; }
    return r850_.set_system(R850SystemConfig{R850System::isdb_t,R850Bandwidth::mhz_6,4063U});
}

Result<void> SingleReceiverFrontend::open_receiver(std::uint8_t receiver) noexcept
{
    if (receiver != 0U) return Result<void>::failure(Error::INVALID_ARGUMENT);
    if (opened_) return Result<void>::failure(Error::BUSY);
    const auto p=acquire_power(); if(!p)return p;
    auto init=initialize_frontend();
    if (!init) { (void)release_power(); return init; }
    opened_=true; satellite_=false; return Result<void>::success();
}

Result<void> SingleReceiverFrontend::tune_terrestrial(std::uint8_t r,std::uint32_t f,
                                                       std::uint32_t timeout) noexcept
{
    (void)timeout; if(r||!opened_)return Result<void>::failure(Error::INVALID_ARGUMENT);
    auto x=tc_t_.set_agc_t(false); if(!x)return x;
    if (receiver_supports(0U, ipc::System::ISDB_S)) { x=tc_s_.sleep_s(true); if(!x)return x; }
    constexpr std::uint8_t regs[]{0x0e,0x0f,0x71}; constexpr std::uint8_t vals[]{0x77,0x10,0x20};
    for(std::size_t i=0;i<3U;++i){x=tc_t_.write_reg(regs[i],vals[i]);if(!x)return x;}
    x=tc_t_.sleep_t(false); if(!x)return x;
    x=tc_t_.write_reg(0x76U,0x0cU);if(!x)return x;
    x=tc_t_.write_reg(0x1fU,0x30U);if(!x)return x;
    x=r850_.wakeup();if(!x)return x; x=r850_.set_frequency(f);if(!x)return x;
    bool pll_locked=false;
    for(std::uint32_t i=0;i<50U;++i){auto locked=r850_.is_pll_locked();if(!locked)return Result<void>::failure(locked.error());if(locked.value()){pll_locked=true;break;}delay_.sleep_ms(10U);}
    if(!pll_locked)return Result<void>::failure(Error::TIMEOUT);
    x=tc_t_.set_agc_t(true);if(!x)return x;
    x=tc_t_.write_reg(0x71U,0x01U);if(!x)return x;
    x=tc_t_.write_reg(0x72U,0x25U);if(!x)return x;
    x=tc_t_.write_reg(0x75U,0x00U);if(!x)return x;
    satellite_=false; delay_.sleep_ms(100U); return Result<void>::success();
}

Result<void> SingleReceiverFrontend::tune_satellite(std::uint8_t r,std::uint32_t f,
                                                     std::uint32_t timeout) noexcept
{
    (void)timeout; if(r||!opened_||!receiver_supports(0U,ipc::System::ISDB_S))return Result<void>::failure(Error::UNSUPPORTED);
    auto x=tc_s_.set_agc_s(false);if(!x)return x;
    x=tc_t_.write_reg(0x0eU,0x11U);if(!x)return x; x=tc_t_.write_reg(0x0fU,0x70U);if(!x)return x;
    x=tc_t_.sleep_t(true);if(!x)return x;
    Tc90522& s=model_==DeviceModel::dtv02a_1t1s_u?tc_s0_:tc_s_;
    x=s.write_reg(0x07U,0x77U);if(!x)return x;
    x=s.write_reg(0x08U,model_==DeviceModel::dtv02a_1t1s_u?0x37U:0x10U);if(!x)return x;
    x=tc_s_.sleep_s(false);if(!x)return x; x=tc_s_.write_reg(0x04U,0x02U);if(!x)return x;
    x=tc_s_.write_reg(0x8eU,0x02U);if(!x)return x; x=tc_t_.write_reg(0x1fU,0x20U);if(!x)return x;
    x=rt710_.set_params(f,28860U,4U);if(!x)return x;
    bool pll_locked=false;
    for(std::uint32_t i=0;i<50U;++i){auto locked=rt710_.is_pll_locked();if(!locked)return Result<void>::failure(locked.error());if(locked.value()){pll_locked=true;break;}delay_.sleep_ms(10U);}
    if(!pll_locked)return Result<void>::failure(Error::TIMEOUT);
    x=tc_s_.set_agc_s(true);if(!x)return x; satellite_=true; return Result<void>::success();
}

Result<bool> SingleReceiverFrontend::is_locked(std::uint8_t r,ipc::System s) noexcept
{ if(r)return Result<bool>::failure(Error::INVALID_ARGUMENT); return s==ipc::System::ISDB_T?tc_t_.is_signal_locked_t():tc_s_.is_signal_locked_s(); }
Result<void> SingleReceiverFrontend::select_satellite_slot(std::uint8_t,std::uint8_t,std::uint32_t) noexcept { return Result<void>::success(); }
Result<void> SingleReceiverFrontend::select_satellite_tsid(std::uint8_t,std::uint16_t,std::uint32_t) noexcept { return Result<void>::success(); }
Result<void> SingleReceiverFrontend::start_capture(std::uint8_t r,ipc::System s) noexcept
{ if(r||!opened_)return Result<void>::failure(Error::INVALID_ARGUMENT); auto x=s==ipc::System::ISDB_T?tc_t_.enable_ts_pins_t(true):tc_s_.enable_ts_pins_s(true); if(x)capturing_=true; return x; }
Result<void> SingleReceiverFrontend::stop_capture(std::uint8_t r,ipc::System s) noexcept
{ if(r)return Result<void>::failure(Error::INVALID_ARGUMENT); auto x=s==ipc::System::ISDB_T?tc_t_.enable_ts_pins_t(false):tc_s_.enable_ts_pins_s(false); if(x)capturing_=false; return x; }
Result<void> SingleReceiverFrontend::close_receiver(std::uint8_t r) noexcept
{ if(r)return Result<void>::failure(Error::INVALID_ARGUMENT); if(capturing_){(void)stop_capture(0U,satellite_?ipc::System::ISDB_S:ipc::System::ISDB_T);} if(lnb_on_){(void)controller_.set_q3u4_lnb_power(false);lnb_on_=false;} if(opened_){(void)r850_.terminate();if(receiver_supports(0U,ipc::System::ISDB_S))(void)rt710_.terminate();opened_=false;} return release_power(); }
Result<void> SingleReceiverFrontend::begin_tune_power(std::uint8_t r,ipc::System s,std::uint8_t v) noexcept
{ if(r||!receiver_supports(r,s))return Result<void>::failure(Error::UNSUPPORTED); if(s==ipc::System::ISDB_T&&v!=0U)return Result<void>::failure(Error::INVALID_ARGUMENT); if(s==ipc::System::ISDB_S&&v!=0U&&v!=15U)return Result<void>::failure(Error::INVALID_ARGUMENT); if(v==15U&&!allow_lnb_power_)return Result<void>::failure(Error::UNSUPPORTED); prior_lnb_on_=lnb_on_; pending_lnb_=true; const bool requested=s==ipc::System::ISDB_S&&v==15U; if(requested!=lnb_on_){const auto x=controller_.set_q3u4_lnb_power(requested);if(!x){pending_lnb_=false;return x;}lnb_on_=requested;}return Result<void>::success(); }
Result<void> SingleReceiverFrontend::commit_tune_power(std::uint8_t) noexcept{pending_lnb_=false;return Result<void>::success();}
Result<void> SingleReceiverFrontend::rollback_tune_power(std::uint8_t) noexcept
{ if(!pending_lnb_||lnb_on_==prior_lnb_on_){pending_lnb_=false;return Result<void>::success();}const auto x=controller_.set_q3u4_lnb_power(prior_lnb_on_);if(x){lnb_on_=prior_lnb_on_;pending_lnb_=false;}return x; }
void SingleReceiverFrontend::mark_receiver_disconnected(std::uint8_t) noexcept {disconnected_=true;}
Result<void> SingleReceiverFrontend::shutdown() noexcept{return close_receiver(0U);}
Result<void> SingleReceiverFrontend::set_power(bool on) noexcept
{ if(on){if(card_powered_)return Result<void>::success();auto x=acquire_power();if(x)card_powered_=true;return x;} if(!card_powered_)return Result<void>::success();card_powered_=false;return release_power(); }
Result<void> SingleReceiverFrontend::initialize_uart() noexcept{return controller_.initialize_card_uart();}
Result<bool> SingleReceiverFrontend::detect_card() noexcept{return controller_.detect_card();}

} // namespace px4::userland
