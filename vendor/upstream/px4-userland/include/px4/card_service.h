// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_CARD_SERVICE_H
#define PX4_USERLAND_CARD_SERVICE_H

#include "px4/card.h"
#include "px4/ipc.h"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace px4::userland {

using CardClientId = std::uint64_t;

class CardProtocolSession {
public:
    virtual ~CardProtocolSession() noexcept = default;
    virtual Result<void> initialize() noexcept = 0;
    virtual Result<std::size_t> transmit(ByteView apdu,
                                         MutableByteView response) noexcept = 0;
    virtual bool initialized() const noexcept = 0;
    virtual const CardAtr& atr() const noexcept = 0;
    virtual void invalidate() noexcept = 0;
};

class NativeCardProtocolSession final : public CardProtocolSession {
public:
    explicit NativeCardProtocolSession(CardSession& session) noexcept : session_(session) {}

    Result<void> initialize() noexcept override { return session_.initialize(); }
    Result<std::size_t> transmit(ByteView apdu,
                                 MutableByteView response) noexcept override
    {
        return session_.transmit(apdu, response);
    }
    bool initialized() const noexcept override { return session_.initialized(); }
    const CardAtr& atr() const noexcept override { return session_.atr(); }
    void invalidate() noexcept override { session_.invalidate(); }

private:
    CardSession& session_;
};

// Device-1-only backend seam. Implementations perform the Q3U4 backend power
// sequence and UART initialization; CardService never addresses device 2.
class CardServiceBackend {
public:
    virtual ~CardServiceBackend() noexcept = default;
    virtual Result<void> set_power(bool on) noexcept = 0;
    virtual Result<void> initialize_uart() noexcept = 0;
    virtual Result<bool> detect_card() noexcept = 0;
};

struct CardServiceStatus final {
    bool present = false;
    bool initialized = false;
    std::uint64_t reader_generation = 1U;
    CardAtr atr{};
};

struct CardServiceConnectResult final {
    std::uint64_t handle = 0U;
    CardAtr atr{};
};

struct CardPresenceChange final {
    bool changed = false;
    bool present = false;
    std::uint64_t reader_generation = 1U;
};

// Socket/USB-independent card ownership service. Calls must be externally
// serialized; px4d's control loop is the single serializer in Increment 8D.
class CardService final {
public:
    CardService(CardServiceBackend& backend, CardProtocolSession& session) noexcept
        : backend_(backend), session_(session)
    {
    }
    ~CardService() noexcept;

    CardService(const CardService&) = delete;
    CardService& operator=(const CardService&) = delete;

    Result<CardServiceStatus> status() noexcept;
    Result<CardPresenceChange> poll_presence() noexcept;
    Result<CardServiceConnectResult> connect(
        CardClientId client, ipc::ShareMode share_mode) noexcept;
    Result<CardAtr> reconnect(CardClientId client, std::uint64_t handle,
                              ipc::ShareMode share_mode,
                              ipc::Disposition disposition) noexcept;
    Result<void> disconnect(CardClientId client, std::uint64_t handle,
                            ipc::Disposition disposition) noexcept;
    Result<CardAtr> reset(CardClientId client, std::uint64_t handle) noexcept;
    Result<std::size_t> transmit(CardClientId client, std::uint64_t handle,
                                 ByteView apdu, MutableByteView response) noexcept;
    Result<void> begin_transaction(CardClientId client,
                                   std::uint64_t handle) noexcept;
    Result<void> end_transaction(CardClientId client, std::uint64_t handle,
                                 ipc::Disposition disposition) noexcept;

    // Connection teardown and daemon shutdown are cleanup operations: handles
    // are discarded even if the final device-1 power-off reports an error.
    Result<void> release_connection(CardClientId client) noexcept;
    Result<void> shutdown() noexcept;

    bool has_handles() const noexcept { return !handles_.empty(); }
    std::size_t handle_count() const noexcept { return handles_.size(); }
    bool powered() const noexcept { return powered_; }
    std::uint64_t reader_generation() const noexcept { return reader_generation_; }

private:
    struct HandleRecord final {
        std::uint64_t handle;
        CardClientId client;
        ipc::ShareMode share_mode;
    };

    Result<void> power_up() noexcept;
    Result<void> power_down() noexcept;
    Result<void> ensure_session() noexcept;
    Result<CardAtr> reset_session(bool preserve_transaction = false) noexcept;
    Result<bool> detect_and_record(bool report_initial_change,
                                   CardPresenceChange* change) noexcept;
    Result<void> apply_disposition(ipc::Disposition disposition) noexcept;
    Result<void> release_handle(std::size_t index) noexcept;
    Result<std::size_t> find_handle(CardClientId client,
                                    std::uint64_t handle) const noexcept;
    bool sharing_allowed(ipc::ShareMode requested,
                         std::size_t excluded_index) const noexcept;
    bool transaction_allows(std::uint64_t handle) const noexcept;
    std::uint64_t allocate_handle() noexcept;
    void invalidate_session() noexcept;
    void abandon_disconnected_hardware() noexcept;

    CardServiceBackend& backend_;
    CardProtocolSession& session_;
    std::vector<HandleRecord> handles_;
    CardAtr cached_atr_{};
    std::uint64_t next_handle_ = 1U;
    std::uint64_t transaction_handle_ = 0U;
    std::uint64_t reader_generation_ = 1U;
    bool powered_ = false;
    bool uart_initialized_ = false;
    bool presence_known_ = false;
    bool present_ = false;
    bool presence_change_pending_ = false;
    CardPresenceChange pending_presence_change_{};
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_CARD_SERVICE_H
