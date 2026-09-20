// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_LOGGING_H
#define PX4_USERLAND_LOGGING_H

#include <cstdint>
#include <string_view>

namespace px4::userland {

enum class LogLevel : std::uint8_t {
    trace = 0,
    debug = 1,
    info = 2,
    warn = 3,
    error = 4,
};

struct LogRecord final {
    LogLevel level;
    std::string_view message;
};

using LogSink = void (*)(const LogRecord& record, void* context) noexcept;

class Logger final {
public:
    explicit Logger(LogLevel minimum_level = LogLevel::info,
                    LogSink sink = nullptr,
                    void* context = nullptr) noexcept;

    void set_minimum_level(LogLevel minimum_level) noexcept;
    void set_sink(LogSink sink, void* context) noexcept;
    bool enabled(LogLevel level) const noexcept;
    void log(LogLevel level, std::string_view message) const noexcept;

private:
    LogLevel minimum_level_;
    LogSink sink_;
    void* context_;
};

const char* log_level_string(LogLevel level) noexcept;

}  // namespace px4::userland

#endif  // PX4_USERLAND_LOGGING_H
