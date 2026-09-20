// SPDX-License-Identifier: GPL-2.0-only
#include "px4/logging.h"

namespace px4::userland {

Logger::Logger(LogLevel minimum_level, LogSink sink, void* context) noexcept
    : minimum_level_(minimum_level), sink_(sink), context_(context)
{
}

void Logger::set_minimum_level(LogLevel minimum_level) noexcept
{
    minimum_level_ = minimum_level;
}

void Logger::set_sink(LogSink sink, void* context) noexcept
{
    sink_ = sink;
    context_ = context;
}

bool Logger::enabled(LogLevel level) const noexcept
{
    return static_cast<std::uint8_t>(level) >= static_cast<std::uint8_t>(minimum_level_);
}

void Logger::log(LogLevel level, std::string_view message) const noexcept
{
    if (sink_ != nullptr && enabled(level)) {
        sink_(LogRecord{level, message}, context_);
    }
}

const char* log_level_string(LogLevel level) noexcept
{
    switch (level) {
    case LogLevel::trace:
        return "TRACE";
    case LogLevel::debug:
        return "DEBUG";
    case LogLevel::info:
        return "INFO";
    case LogLevel::warn:
        return "WARN";
    case LogLevel::error:
        return "ERROR";
    }

    return "UNKNOWN";
}

}  // namespace px4::userland
