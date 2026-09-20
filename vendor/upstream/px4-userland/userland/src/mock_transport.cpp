// SPDX-License-Identifier: GPL-2.0-only
#include "px4/mock_transport.h"

#include <cstring>
#include <utility>

namespace px4::userland {

void MockTransport::add_expectation(MockOperation operation, std::uint8_t endpoint,
                                    MockOutcome outcome, ByteView payload,
                                    std::size_t transferred, const StreamConfig& config)
{
    Expectation expectation{operation, outcome, endpoint, {}, transferred, config};
    if (payload.size != 0U) {
        expectation.payload.assign(payload.data, payload.data + payload.size);
    }
    expectations_.push_back(std::move(expectation));
}

void MockTransport::expect_bulk_read(std::uint8_t endpoint, ByteView response,
                                     MockOutcome outcome, std::size_t transferred)
{
    add_expectation(MockOperation::bulk_read, endpoint, outcome, response, transferred,
                    StreamConfig{});
}

void MockTransport::expect_bulk_write(std::uint8_t endpoint, ByteView request,
                                      MockOutcome outcome, std::size_t transferred)
{
    add_expectation(MockOperation::bulk_write, endpoint, outcome, request, transferred,
                    StreamConfig{});
}

void MockTransport::expect_stream_start(const StreamConfig& config, MockOutcome outcome)
{
    add_expectation(MockOperation::stream_start, 0U, outcome, ByteView{nullptr, 0U},
                    kUsePayloadSize, config);
}

void MockTransport::expect_stream_event(ByteView response, MockOutcome outcome,
                                        std::size_t transferred)
{
    add_expectation(MockOperation::stream_wait, 0U, outcome, response, transferred,
                    StreamConfig{});
}

void MockTransport::expect_stream_cancel(MockOutcome outcome)
{
    add_expectation(MockOperation::stream_cancel, 0U, outcome, ByteView{nullptr, 0U},
                    kUsePayloadSize, StreamConfig{});
}

void MockTransport::expect_stream_stop(MockOutcome outcome)
{
    add_expectation(MockOperation::stream_stop, 0U, outcome, ByteView{nullptr, 0U},
                    kUsePayloadSize, StreamConfig{});
}

MockTransport::Expectation* MockTransport::consume(MockOperation operation) noexcept
{
    operations_.push_back(operation);
    if (next_expectation_ >= expectations_.size()) {
        return nullptr;
    }
    Expectation& expectation = expectations_[next_expectation_];
    if (expectation.operation != operation) {
        return nullptr;
    }
    ++next_expectation_;
    return &expectation;
}

Error MockTransport::outcome_error(MockOutcome outcome) noexcept
{
    switch (outcome) {
    case MockOutcome::success:
    case MockOutcome::short_transfer:
        return Error::OK;
    case MockOutcome::timeout:
        return Error::TIMEOUT;
    case MockOutcome::disconnect:
        return Error::DISCONNECTED;
    case MockOutcome::protocol_error:
        return Error::PROTOCOL_ERROR;
    case MockOutcome::usb_io:
        return Error::USB_IO;
    }
    return Error::INTERNAL;
}

std::size_t MockTransport::default_transfer(MockOutcome outcome, std::size_t payload_size) noexcept
{
    if (outcome == MockOutcome::timeout) {
        return 0U;
    }
    if (outcome == MockOutcome::short_transfer && payload_size != 0U) {
        return payload_size - 1U;
    }
    return payload_size;
}

bool MockTransport::valid_bulk_size(std::size_t size) const noexcept
{
    return size <= kMaxCommandTransfer;
}

bool MockTransport::valid_stream_config(const StreamConfig& config) const noexcept
{
    return config.endpoint == kTsInEndpoint && config.transfer_size != 0U &&
           config.transfer_count != 0U && config.transfer_size <= kMaxStreamTransfer;
}

Result<std::size_t> MockTransport::bulk_read(std::uint8_t endpoint, MutableByteView output,
                                             Timeout timeout,
                                             BulkReadObservation* observation) noexcept
{
    if (observation != nullptr) {
        *observation = BulkReadObservation{};
    }
    const auto failure = [observation](Error error) noexcept {
        if (observation != nullptr) {
            *observation = BulkReadObservation{error, 0U};
        }
        return Result<std::size_t>::failure(error);
    };
    if ((endpoint & 0x80U) == 0U || endpoint == 0U) {
        return failure(Error::INVALID_ARGUMENT);
    }
    if (!valid_bulk_size(output.size)) {
        return failure(Error::BUFFER_TOO_SMALL);
    }
    if (output.size != 0U && output.data == nullptr) {
        return failure(Error::INVALID_ARGUMENT);
    }

    timeouts_.push_back(timeout);
    bulk_read_sizes_.push_back(output.size);
    Expectation* expectation = consume(MockOperation::bulk_read);
    if (expectation == nullptr || expectation->endpoint != endpoint) {
        return failure(Error::PROTOCOL_ERROR);
    }
    if (expectation->payload.size() > output.size) {
        return failure(Error::BUFFER_TOO_SMALL);
    }
    const std::size_t transfer = expectation->transferred == kUsePayloadSize
                                     ? default_transfer(expectation->outcome, expectation->payload.size())
                                     : expectation->transferred;
    if (transfer > output.size) {
        return failure(Error::INTERNAL);
    }
    if (transfer > expectation->payload.size()) {
        return failure(Error::PROTOCOL_ERROR);
    }
    const Error error = outcome_error(expectation->outcome);
    if (error != Error::OK &&
        !(expectation->outcome == MockOutcome::timeout && transfer > 0U)) {
        if (observation != nullptr) {
            *observation = BulkReadObservation{error, transfer};
        }
        return Result<std::size_t>::failure(error);
    }
    if (transfer != 0U) {
        std::memcpy(output.data, expectation->payload.data(), transfer);
    }
    if (observation != nullptr) {
        *observation = BulkReadObservation{
            expectation->outcome == MockOutcome::timeout ? Error::TIMEOUT : Error::OK,
            transfer};
    }
    return Result<std::size_t>::success(transfer);
}

Result<std::size_t> MockTransport::bulk_write(std::uint8_t endpoint, ByteView input,
                                              Timeout timeout) noexcept
{
    if ((endpoint & 0x80U) != 0U || endpoint == 0U) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }
    if (!valid_bulk_size(input.size)) {
        return Result<std::size_t>::failure(Error::BUFFER_TOO_SMALL);
    }
    if (input.size != 0U && input.data == nullptr) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }

    timeouts_.push_back(timeout);
    Expectation* expectation = consume(MockOperation::bulk_write);
    if (expectation == nullptr || expectation->endpoint != endpoint) {
        return Result<std::size_t>::failure(Error::PROTOCOL_ERROR);
    }
    const Error error = outcome_error(expectation->outcome);
    if (error != Error::OK) {
        return Result<std::size_t>::failure(error);
    }
    if (expectation->payload.size() != input.size ||
        (input.size != 0U && std::memcmp(expectation->payload.data(), input.data, input.size) != 0)) {
        return Result<std::size_t>::failure(Error::PROTOCOL_ERROR);
    }
    const std::size_t transfer = expectation->transferred == kUsePayloadSize
                                     ? default_transfer(expectation->outcome, input.size)
                                     : expectation->transferred;
    if (transfer > input.size) {
        return Result<std::size_t>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<std::size_t>::success(transfer);
}

Result<void> MockTransport::start_stream(const StreamConfig& config) noexcept
{
    if (!valid_stream_config(config)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (stream_active_) {
        return Result<void>::failure(Error::BUSY);
    }
    Expectation* expectation = consume(MockOperation::stream_start);
    if (expectation == nullptr || expectation->stream_config.endpoint != config.endpoint ||
        expectation->stream_config.transfer_size != config.transfer_size ||
        expectation->stream_config.transfer_count != config.transfer_count) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }
    const Error error = outcome_error(expectation->outcome);
    if (error != Error::OK) {
        return Result<void>::failure(error);
    }
    stream_active_ = true;
    active_stream_config_ = config;
    return Result<void>::success();
}

Result<StreamEvent> MockTransport::wait_stream(Timeout) noexcept
{
    if (!stream_active_) {
        return Result<StreamEvent>::failure(Error::NOT_READY);
    }
    Expectation* expectation = consume(MockOperation::stream_wait);
    if (expectation == nullptr) {
        return Result<StreamEvent>::failure(Error::PROTOCOL_ERROR);
    }
    const Error error = outcome_error(expectation->outcome);
    if (error != Error::OK) {
        if (error == Error::DISCONNECTED) {
            stream_active_ = false;
        }
        return Result<StreamEvent>::failure(error);
    }
    const std::size_t transfer = expectation->transferred == kUsePayloadSize
                                     ? default_transfer(expectation->outcome, expectation->payload.size())
                                     : expectation->transferred;
    if (transfer > expectation->payload.size() || transfer > kMaxStreamTransfer ||
        transfer > active_stream_config_.transfer_size) {
        return Result<StreamEvent>::failure(Error::PROTOCOL_ERROR);
    }
    last_stream_data_.assign(expectation->payload.begin(), expectation->payload.begin() + transfer);
    const StreamEventKind kind = expectation->outcome == MockOutcome::short_transfer
                                     ? StreamEventKind::short_transfer
                                     : StreamEventKind::data;
    return Result<StreamEvent>::success(StreamEvent{kind, last_stream_data_.data(),
                                                    last_stream_data_.size()});
}

Result<void> MockTransport::cancel_stream() noexcept
{
    if (!stream_active_) {
        return Result<void>::success();
    }
    Expectation* expectation = consume(MockOperation::stream_cancel);
    stream_active_ = false;
    if (expectation == nullptr) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }
    const Error error = outcome_error(expectation->outcome);
    return error == Error::OK ? Result<void>::success() : Result<void>::failure(error);
}

Result<void> MockTransport::stop_stream() noexcept
{
    if (!stream_active_) {
        return Result<void>::success();
    }
    Expectation* expectation = consume(MockOperation::stream_stop);
    stream_active_ = false;
    if (expectation == nullptr) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }
    const Error error = outcome_error(expectation->outcome);
    return error == Error::OK ? Result<void>::success() : Result<void>::failure(error);
}

std::size_t MockTransport::remaining_expectations() const noexcept
{
    return expectations_.size() - next_expectation_;
}

}  // namespace px4::userland
