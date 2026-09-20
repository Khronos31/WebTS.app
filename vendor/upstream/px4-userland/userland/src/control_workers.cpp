// SPDX-License-Identifier: GPL-2.0-only
#include "control_workers.h"

#include <atomic>
#include <cerrno>
#include <fcntl.h>
#include <pthread.h>
#include <poll.h>
#include <unistd.h>

namespace px4::userland::ipc::posix {
namespace {

bool operation_lane_valid(ControlWorkerLane lane,
                          const ControlWorkerTask& task) noexcept
{
    if (task.operation == ControlWorkerOperation::tuner_status) {
        return lane == ControlWorkerLane::tuner_dev1;
    }
    switch (task.operation) {
    case ControlWorkerOperation::tuner_status:
        return false;
    case ControlWorkerOperation::tuner_acquire:
    case ControlWorkerOperation::tuner_release:
    case ControlWorkerOperation::tuner_tune:
    case ControlWorkerOperation::tuner_start_stream:
    case ControlWorkerOperation::tuner_stop_stream:
    case ControlWorkerOperation::tuner_stats:
    case ControlWorkerOperation::tuner_attach_stream:
    case ControlWorkerOperation::tuner_detach_stream:
        if (task.receiver >= kReceiverCount) {
            return false;
        }
        return lane == (task.receiver < 4U ? ControlWorkerLane::tuner_dev1 :
                                             ControlWorkerLane::tuner_dev2);
    case ControlWorkerOperation::tuner_shutdown:
        return lane == ControlWorkerLane::tuner_dev1;
    case ControlWorkerOperation::card_status:
    case ControlWorkerOperation::card_status_combined:
    case ControlWorkerOperation::card_presence:
    case ControlWorkerOperation::card_connect:
    case ControlWorkerOperation::card_reconnect:
    case ControlWorkerOperation::card_disconnect:
    case ControlWorkerOperation::card_reset:
    case ControlWorkerOperation::card_transmit:
    case ControlWorkerOperation::card_begin_transaction:
    case ControlWorkerOperation::card_end_transaction:
    case ControlWorkerOperation::card_release_connection:
    case ControlWorkerOperation::card_shutdown:
        return lane == ControlWorkerLane::card;
    }
    return false;
}

#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
ControlWorkerStartupOptions* test_startup_options = nullptr;
#endif

class WakePipe final {
public:
    WakePipe() noexcept = default;
    ~WakePipe() noexcept { close(); }

    Result<void> open() noexcept
    {
        int descriptors[2] = {-1, -1};
        while (::pipe(descriptors) != 0) {
            if (errno == EINTR) continue;
            return Result<void>::failure(Error::INTERNAL);
        }
        if (!set_flag(descriptors[0], F_GETFL, F_SETFL, O_NONBLOCK) ||
            !set_flag(descriptors[1], F_GETFL, F_SETFL, O_NONBLOCK) ||
            !set_flag(descriptors[0], F_GETFD, F_SETFD, FD_CLOEXEC) ||
            !set_flag(descriptors[1], F_GETFD, F_SETFD, FD_CLOEXEC)) {
            ::close(descriptors[0]);
            ::close(descriptors[1]);
            return Result<void>::failure(Error::INTERNAL);
        }
        read_fd_ = descriptors[0];
        write_fd_ = descriptors[1];
        return Result<void>::success();
    }

    void close() noexcept
    {
        if (read_fd_ >= 0) ::close(read_fd_);
        if (write_fd_ >= 0) ::close(write_fd_);
        read_fd_ = -1;
        write_fd_ = -1;
    }

    void signal(std::atomic<Error>& error) noexcept
    {
        const std::uint8_t byte = 1U;
        while (true) {
            const ssize_t written = ::write(write_fd_, &byte, sizeof(byte));
            if (written == static_cast<ssize_t>(sizeof(byte))) return;
            if (written < 0 && errno == EINTR) continue;
            if (written < 0 && errno == EAGAIN) return;
            error.store(Error::INTERNAL);
            return;
        }
    }

    void drain() noexcept
    {
        std::array<std::uint8_t, 64U> bytes{};
        while (true) {
            const ssize_t read_count = ::read(read_fd_, bytes.data(), bytes.size());
            if (read_count > 0) continue;
            if (read_count < 0 && errno == EINTR) continue;
            return;
        }
    }

    int read_fd() const noexcept { return read_fd_; }

private:
    static bool set_flag(int descriptor, int get_command, int set_command,
                         int flag) noexcept
    {
        int current = 0;
        while ((current = ::fcntl(descriptor, get_command)) < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        while (::fcntl(descriptor, set_command, current | flag) < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        return true;
    }

    int read_fd_ = -1;
    int write_fd_ = -1;
};

}  // namespace

struct ControlWorkerLanes::Impl final {
    struct Lane final {
        Impl& owner;
        ControlWorkerLane lane;
        pthread_t thread{};
        pthread_mutex_t mutex{};
        pthread_cond_t task_ready{};
        pthread_cond_t completion_room{};
        bool mutex_initialized = false;
        bool task_ready_initialized = false;
        bool completion_room_initialized = false;
        bool started = false;
        bool joined = false;
        bool stopping = false;
        std::array<ControlWorkerTask, kControlWorkerQueueCapacity> tasks{};
        std::size_t task_head = 0U;
        std::size_t task_count = 0U;
        std::array<ControlWorkerCompletion, kControlWorkerQueueCapacity> completions{};
        std::size_t completion_head = 0U;
        std::size_t completion_count = 0U;
        std::atomic<std::size_t> active_tasks{0U};

        Lane(Impl& owner_value, ControlWorkerLane lane_value) noexcept
            : owner(owner_value), lane(lane_value)
        {
        }

        static void* run(void* context) noexcept
        {
            static_cast<Lane*>(context)->run_loop();
            return nullptr;
        }

        Result<void> initialize() noexcept
        {
            if (pthread_mutex_init(&mutex, nullptr) != 0) {
                return Result<void>::failure(Error::INTERNAL);
            }
            mutex_initialized = true;
            if (pthread_cond_init(&task_ready, nullptr) != 0) {
                pthread_mutex_destroy(&mutex);
                mutex_initialized = false;
                return Result<void>::failure(Error::INTERNAL);
            }
            task_ready_initialized = true;
            if (pthread_cond_init(&completion_room, nullptr) != 0) {
                pthread_cond_destroy(&task_ready);
                task_ready_initialized = false;
                pthread_mutex_destroy(&mutex);
                mutex_initialized = false;
                return Result<void>::failure(Error::INTERNAL);
            }
            completion_room_initialized = true;
            owner.live_threads.fetch_add(1U);
            if (pthread_create(&thread, nullptr, &Lane::run, this) != 0) {
                owner.live_threads.fetch_sub(1U);
                pthread_cond_destroy(&completion_room);
                completion_room_initialized = false;
                pthread_cond_destroy(&task_ready);
                task_ready_initialized = false;
                pthread_mutex_destroy(&mutex);
                mutex_initialized = false;
                return Result<void>::failure(Error::INTERNAL);
            }
            started = true;
            return Result<void>::success();
        }

        void destroy_sync() noexcept
        {
            if (completion_room_initialized) pthread_cond_destroy(&completion_room);
            if (task_ready_initialized) pthread_cond_destroy(&task_ready);
            if (mutex_initialized) pthread_mutex_destroy(&mutex);
            completion_room_initialized = false;
            task_ready_initialized = false;
            mutex_initialized = false;
        }

        void run_loop() noexcept
        {
            while (true) {
                ControlWorkerTask task{};
                if (!pop_task(task)) break;
                ControlWorkerCompletion completion = owner.execute(task);
#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
                if (task.operation == ControlWorkerOperation::tuner_attach_stream &&
                    owner.before_tuner_attach_completion != nullptr) {
                    owner.before_tuner_attach_completion(
                        owner.before_tuner_attach_completion_context);
                }
#endif
                (void)push_completion(completion);
                active_tasks.fetch_sub(1U);
            }
            owner.live_threads.fetch_sub(1U);
        }

        bool pop_task(ControlWorkerTask& task) noexcept
        {
            if (pthread_mutex_lock(&mutex) != 0) {
                owner.worker_error.store(Error::INTERNAL);
                return false;
            }
            while (task_count == 0U && !stopping) {
                if (pthread_cond_wait(&task_ready, &mutex) != 0) {
                    owner.worker_error.store(Error::INTERNAL);
                    (void)pthread_mutex_unlock(&mutex);
                    return false;
                }
            }
            if (task_count == 0U && stopping) {
                (void)pthread_mutex_unlock(&mutex);
                return false;
            }
            task = tasks[task_head];
            task_head = (task_head + 1U) % tasks.size();
            --task_count;
            // Dequeue and active transition are one mutex-protected state
            // change, so idle() cannot observe a taken-but-not-active task.
            active_tasks.fetch_add(1U);
            (void)pthread_mutex_unlock(&mutex);
            return true;
        }

        bool push_completion(const ControlWorkerCompletion& completion) noexcept
        {
            if (pthread_mutex_lock(&mutex) != 0) {
                owner.worker_error.store(Error::INTERNAL);
                return false;
            }
            while (completion_count == completions.size()) {
                if (pthread_cond_wait(&completion_room, &mutex) != 0) {
                    owner.worker_error.store(Error::INTERNAL);
                    (void)pthread_mutex_unlock(&mutex);
                    return false;
                }
            }
            const std::size_t position =
                (completion_head + completion_count) % completions.size();
            completions[position] = completion;
            ++completion_count;
            (void)pthread_mutex_unlock(&mutex);
            owner.wake.signal(owner.worker_error);
            return true;
        }

        Result<void> submit(const ControlWorkerTask& task) noexcept
        {
#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
            if (owner.fail_tuner_attach_submit &&
                task.operation == ControlWorkerOperation::tuner_attach_stream) {
                return Result<void>::failure(Error::BUSY);
            }
#endif
            if (pthread_mutex_lock(&mutex) != 0) {
                return Result<void>::failure(Error::INTERNAL);
            }
            if (stopping) {
                (void)pthread_mutex_unlock(&mutex);
                return Result<void>::failure(Error::NOT_READY);
            }
            if (task_count == tasks.size()) {
                (void)pthread_mutex_unlock(&mutex);
                return Result<void>::failure(Error::BUSY);
            }
            const std::size_t position =
                (task_head + task_count) % tasks.size();
            tasks[position] = task;
            ++task_count;
            if (pthread_cond_signal(&task_ready) != 0) {
                --task_count;
                (void)pthread_mutex_unlock(&mutex);
                return Result<void>::failure(Error::INTERNAL);
            }
            (void)pthread_mutex_unlock(&mutex);
            return Result<void>::success();
        }

        bool try_pop(ControlWorkerCompletion& completion) noexcept
        {
            if (pthread_mutex_lock(&mutex) != 0) {
                owner.worker_error.store(Error::INTERNAL);
                return false;
            }
            if (completion_count == 0U) {
                (void)pthread_mutex_unlock(&mutex);
                return false;
            }
            completion = completions[completion_head];
            completion_head = (completion_head + 1U) % completions.size();
            --completion_count;
            (void)pthread_cond_signal(&completion_room);
            (void)pthread_mutex_unlock(&mutex);
            return true;
        }

        std::size_t pending_completions() const noexcept
        {
            if (pthread_mutex_lock(const_cast<pthread_mutex_t*>(&mutex)) != 0) {
                return 0U;
            }
            const std::size_t result = completion_count;
            (void)pthread_mutex_unlock(const_cast<pthread_mutex_t*>(&mutex));
            return result;
        }

        void stop() noexcept
        {
            if (pthread_mutex_lock(&mutex) != 0) {
                owner.worker_error.store(Error::INTERNAL);
                return;
            }
            stopping = true;
            (void)pthread_cond_broadcast(&task_ready);
            (void)pthread_cond_broadcast(&completion_room);
            (void)pthread_mutex_unlock(&mutex);
        }

        bool idle() const noexcept
        {
            if (pthread_mutex_lock(const_cast<pthread_mutex_t*>(&mutex)) != 0) {
                return false;
            }
            const bool result = task_count == 0U && completion_count == 0U &&
                                active_tasks.load() == 0U;
            (void)pthread_mutex_unlock(const_cast<pthread_mutex_t*>(&mutex));
            return result;
        }
    };

    CardService& card_service;
    TunerService& tuner_service;
    WakePipe wake;
    std::array<std::unique_ptr<Lane>, 3U> lanes;
    std::atomic<std::size_t> live_threads{0U};
    std::atomic<Error> worker_error{Error::OK};
    bool joined = false;
#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
    bool fail_tuner_attach_submit = false;
    void (*before_tuner_attach_completion)(void*) noexcept = nullptr;
    void* before_tuner_attach_completion_context = nullptr;
#endif

    Impl(CardService& card, TunerService& tuner
#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
         , const ControlWorkerStartupOptions* options = nullptr
#endif
         ) noexcept
        : card_service(card), tuner_service(tuner)
    {
#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
        if (options != nullptr) {
            fail_tuner_attach_submit = options->fail_tuner_attach_submit;
            before_tuner_attach_completion =
                options->before_tuner_attach_completion;
            before_tuner_attach_completion_context =
                options->before_tuner_attach_completion_context;
        }
#endif
    }

    ControlWorkerCompletion execute(const ControlWorkerTask& task) noexcept
    {
        ControlWorkerCompletion completion{};
        completion.type = task.type;
        completion.kind = task.kind;
        completion.operation = task.operation;
        completion.client_id = task.client_id;
        completion.connection_id = task.connection_id;
        completion.request_id = task.request_id;
        completion.receiver = task.receiver;
        completion.lease_id = task.lease_id;
        completion.card_handle = task.card_handle;
        Error operation_error = Error::OK;
        switch (task.operation) {
        case ControlWorkerOperation::tuner_acquire: {
            const auto result = tuner_service.acquire(task.client_id, task.receiver);
            if (!result) operation_error = result.error();
            else completion.tuner_acquire = result.value();
            break;
        }
        case ControlWorkerOperation::tuner_release: {
            const auto result = tuner_service.release(task.client_id, task.lease_id);
            if (!result) operation_error = result.error();
            break;
        }
        case ControlWorkerOperation::tuner_tune: {
            const auto result = tuner_service.tune(task.client_id, task.tune);
            if (!result) operation_error = result.error();
            else completion.tune_response = result.value();
            break;
        }
        case ControlWorkerOperation::tuner_start_stream: {
            const auto result = tuner_service.start_stream(
                task.client_id, task.lease_id);
            if (!result) operation_error = result.error();
            break;
        }
        case ControlWorkerOperation::tuner_stop_stream: {
            const auto result = tuner_service.stop_stream(
                task.client_id, task.lease_id);
            if (!result) operation_error = result.error();
            else {
                completion.stream_final_snapshot = result.value();
                completion.stream_snapshot_valid = true;
            }
            break;
        }
        case ControlWorkerOperation::tuner_stats: {
            const auto result = tuner_service.stats(
                task.client_id, task.lease_id);
            if (!result) operation_error = result.error();
            else completion.stream_counters = result.value();
            break;
        }
        case ControlWorkerOperation::tuner_attach_stream: {
            const auto result = tuner_service.attach_stream(task.lease_id, task.nonce);
            if (!result) operation_error = result.error();
            else {
                completion.tuner_attachment = result.value();
                completion.tuner_attachment_valid = true;
            }
            break;
        }
        case ControlWorkerOperation::tuner_detach_stream: {
            const auto result = tuner_service.detach_stream(task.attachment);
            if (!result) operation_error = result.error();
            break;
        }
        case ControlWorkerOperation::tuner_status: {
            const auto result = tuner_service.status();
            if (!result) operation_error = result.error();
            else {
                completion.tuner_status = result.value();
                completion.tuner_status_valid = true;
            }
            break;
        }
        case ControlWorkerOperation::tuner_shutdown: {
            const auto result = tuner_service.shutdown();
            if (!result) operation_error = result.error();
            break;
        }
        case ControlWorkerOperation::card_status: {
            const auto result = card_service.status();
            if (!result) operation_error = result.error();
            else completion.card_status = result.value();
            break;
        }
        case ControlWorkerOperation::card_status_combined: {
            const auto card = card_service.status();
            if (!card) {
                operation_error = card.error();
                break;
            }
            completion.card_status = card.value();
            const auto tuner = tuner_service.status();
            if (!tuner) {
                operation_error = tuner.error();
                break;
            }
            completion.tuner_status = tuner.value();
            completion.tuner_status_valid = true;
            break;
        }
        case ControlWorkerOperation::card_presence: {
            const auto result = card_service.poll_presence();
            if (!result) operation_error = result.error();
            else completion.card_presence = result.value();
            break;
        }
        case ControlWorkerOperation::card_connect: {
            const auto result = card_service.connect(task.client_id, task.share_mode);
            if (!result) operation_error = result.error();
            else completion.card_connect = result.value();
            break;
        }
        case ControlWorkerOperation::card_reconnect: {
            const auto result = card_service.reconnect(
                task.client_id, task.card_handle, task.share_mode, task.disposition);
            if (!result) operation_error = result.error();
            else completion.atr = result.value();
            break;
        }
        case ControlWorkerOperation::card_disconnect: {
            const auto result = card_service.disconnect(
                task.client_id, task.card_handle, task.disposition);
            if (!result) operation_error = result.error();
            break;
        }
        case ControlWorkerOperation::card_reset: {
            const auto result = card_service.reset(task.client_id, task.card_handle);
            if (!result) operation_error = result.error();
            else completion.atr = result.value();
            break;
        }
        case ControlWorkerOperation::card_transmit: {
            const auto result = card_service.transmit(
                task.client_id, task.card_handle,
                ByteView{task.apdu.data(), task.apdu_size},
                MutableByteView{completion.card_response.data(), completion.card_response.size()});
            if (!result) operation_error = result.error();
            else completion.card_response_size = result.value();
            break;
        }
        case ControlWorkerOperation::card_begin_transaction: {
            const auto result = card_service.begin_transaction(
                task.client_id, task.card_handle);
            if (!result) operation_error = result.error();
            break;
        }
        case ControlWorkerOperation::card_end_transaction: {
            const auto result = card_service.end_transaction(
                task.client_id, task.card_handle, task.disposition);
            if (!result) operation_error = result.error();
            break;
        }
        case ControlWorkerOperation::card_release_connection: {
            const auto result = card_service.release_connection(task.client_id);
            if (!result) operation_error = result.error();
            break;
        }
        case ControlWorkerOperation::card_shutdown: {
            const auto result = card_service.shutdown();
            if (!result) operation_error = result.error();
            break;
        }
        }
        if (task.operation == ControlWorkerOperation::tuner_acquire ||
            task.operation == ControlWorkerOperation::tuner_release ||
            task.operation == ControlWorkerOperation::tuner_tune ||
            task.operation == ControlWorkerOperation::tuner_start_stream ||
            task.operation == ControlWorkerOperation::tuner_stop_stream ||
            task.operation == ControlWorkerOperation::tuner_stats ||
            task.operation == ControlWorkerOperation::tuner_attach_stream ||
            task.operation == ControlWorkerOperation::tuner_detach_stream) {
            const auto status = tuner_service.status();
            if (status) {
                completion.tuner_status = status.value();
                completion.tuner_status_valid = true;
            } else if (operation_error == Error::OK) {
                operation_error = status.error();
            }
        }
        completion.error = operation_error;
        return completion;
    }
};

ControlWorkerLanes::ControlWorkerLanes(std::unique_ptr<Impl> impl) noexcept
    : impl_(std::move(impl))
{
}

Result<std::unique_ptr<ControlWorkerLanes>> ControlWorkerLanes::create(
    CardService& card_service, TunerService& tuner_service) noexcept
{
#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
    if (test_startup_options != nullptr) {
        ControlWorkerStartupOptions* options = test_startup_options;
        test_startup_options = nullptr;
        return create_for_test(card_service, tuner_service, *options);
    }
#endif
    auto impl = std::unique_ptr<Impl>(new Impl(card_service, tuner_service));
    if (!impl->wake.open()) {
        return Result<std::unique_ptr<ControlWorkerLanes>>::failure(Error::INTERNAL);
    }
    const std::array<ControlWorkerLane, 3U> lane_ids{
        ControlWorkerLane::tuner_dev1, ControlWorkerLane::tuner_dev2,
        ControlWorkerLane::card};
    for (std::size_t index = 0U; index < lane_ids.size(); ++index) {
        impl->lanes[index] = std::unique_ptr<Impl::Lane>(
            new Impl::Lane(*impl, lane_ids[index]));
        const auto initialized = impl->lanes[index]->initialize();
        if (!initialized) {
            for (std::size_t stop = 0U; stop <= index; ++stop) {
                if (impl->lanes[stop] != nullptr && impl->lanes[stop]->started) {
                    impl->lanes[stop]->stop();
                }
            }
            for (std::size_t join = 0U; join <= index; ++join) {
                if (impl->lanes[join] != nullptr && impl->lanes[join]->started) {
                    (void)pthread_join(impl->lanes[join]->thread, nullptr);
                    impl->lanes[join]->joined = true;
                }
                if (impl->lanes[join] != nullptr) impl->lanes[join]->destroy_sync();
            }
            return Result<std::unique_ptr<ControlWorkerLanes>>::failure(
                Error::INTERNAL);
        }
    }
    return Result<std::unique_ptr<ControlWorkerLanes>>::success(
        std::unique_ptr<ControlWorkerLanes>(new ControlWorkerLanes(std::move(impl))));
}

#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
void ControlWorkerLanes::set_test_startup_options(
    ControlWorkerStartupOptions* options) noexcept
{
    test_startup_options = options;
}

Result<std::unique_ptr<ControlWorkerLanes>> ControlWorkerLanes::create_for_test(
    CardService& card_service, TunerService& tuner_service,
    const ControlWorkerStartupOptions& options) noexcept
{
    auto impl = std::unique_ptr<Impl>(
        new Impl(card_service, tuner_service, &options));
    if (options.fail_wake_pipe || !impl->wake.open()) {
        return Result<std::unique_ptr<ControlWorkerLanes>>::failure(Error::INTERNAL);
    }
    const std::array<ControlWorkerLane, 3U> lane_ids{
        ControlWorkerLane::tuner_dev1, ControlWorkerLane::tuner_dev2,
        ControlWorkerLane::card};
    for (std::size_t index = 0U; index < lane_ids.size(); ++index) {
        if (options.fail_lane == static_cast<int>(index)) {
            for (std::size_t stop = 0U; stop < index; ++stop) {
                if (impl->lanes[stop] != nullptr && impl->lanes[stop]->started) {
                    impl->lanes[stop]->stop();
                }
            }
            for (std::size_t join = 0U; join < index; ++join) {
                if (impl->lanes[join] != nullptr && impl->lanes[join]->started) {
                    (void)pthread_join(impl->lanes[join]->thread, nullptr);
                    impl->lanes[join]->joined = true;
                    impl->lanes[join]->destroy_sync();
                }
            }
            return Result<std::unique_ptr<ControlWorkerLanes>>::failure(Error::INTERNAL);
        }
        impl->lanes[index] = std::unique_ptr<Impl::Lane>(
            new Impl::Lane(*impl, lane_ids[index]));
        const auto initialized = impl->lanes[index]->initialize();
        if (!initialized) {
            for (std::size_t stop = 0U; stop <= index; ++stop) {
                if (impl->lanes[stop] != nullptr && impl->lanes[stop]->started) {
                    impl->lanes[stop]->stop();
                }
            }
            for (std::size_t join = 0U; join <= index; ++join) {
                if (impl->lanes[join] != nullptr && impl->lanes[join]->started) {
                    (void)pthread_join(impl->lanes[join]->thread, nullptr);
                    impl->lanes[join]->joined = true;
                }
                if (impl->lanes[join] != nullptr) impl->lanes[join]->destroy_sync();
            }
            return Result<std::unique_ptr<ControlWorkerLanes>>::failure(
                Error::INTERNAL);
        }
    }
    return Result<std::unique_ptr<ControlWorkerLanes>>::success(
        std::unique_ptr<ControlWorkerLanes>(new ControlWorkerLanes(std::move(impl))));
}
#endif

ControlWorkerLanes::~ControlWorkerLanes() noexcept
{
    if (!impl_) return;
    (void)stop_and_join();
    for (auto& lane : impl_->lanes) {
        if (lane != nullptr) lane->destroy_sync();
    }
}

Result<void> ControlWorkerLanes::submit(ControlWorkerLane lane,
                                        const ControlWorkerTask& task) noexcept
{
    if (!impl_) return Result<void>::failure(Error::NOT_READY);
    const std::size_t index = static_cast<std::size_t>(lane);
    if (index >= impl_->lanes.size() || impl_->lanes[index] == nullptr) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (!operation_lane_valid(lane, task)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    return impl_->lanes[index]->submit(task);
}

bool ControlWorkerLanes::try_pop(ControlWorkerLane lane,
                                 ControlWorkerCompletion& completion) noexcept
{
    if (!impl_) return false;
    const std::size_t index = static_cast<std::size_t>(lane);
    return index < impl_->lanes.size() && impl_->lanes[index] != nullptr &&
           impl_->lanes[index]->try_pop(completion);
}

#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
std::size_t ControlWorkerLanes::pending_completions_for_test(
    ControlWorkerLane lane) const noexcept
{
    if (!impl_) return 0U;
    const std::size_t index = static_cast<std::size_t>(lane);
    return index < impl_->lanes.size() && impl_->lanes[index] != nullptr ?
               impl_->lanes[index]->pending_completions() : 0U;
}
#endif

int ControlWorkerLanes::wake_fd() const noexcept
{
    return impl_ ? impl_->wake.read_fd() : -1;
}

void ControlWorkerLanes::drain_wake() noexcept
{
    if (impl_) impl_->wake.drain();
}

Error ControlWorkerLanes::error() const noexcept
{
    if (!impl_) return Error::NOT_READY;
    const Error wake_error = impl_->worker_error.load();
    return wake_error == Error::OK ? Error::OK : wake_error;
}

bool ControlWorkerLanes::idle() const noexcept
{
    if (!impl_) return true;
    for (const auto& lane : impl_->lanes) {
        if (lane != nullptr && !lane->idle()) return false;
    }
    return true;
}

std::size_t ControlWorkerLanes::live_thread_count() const noexcept
{
    return impl_ ? impl_->live_threads.load() : 0U;
}

Result<void> ControlWorkerLanes::request_stop() noexcept
{
    if (!impl_) return Result<void>::success();
    for (auto& lane : impl_->lanes) {
        if (lane != nullptr && lane->started) lane->stop();
    }
    const Error error = impl_->worker_error.load();
    return error == Error::OK ? Result<void>::success()
                              : Result<void>::failure(error);
}

Result<void> ControlWorkerLanes::stop_and_join() noexcept
{
    if (!impl_) return Result<void>::success();
    Error first = Error::OK;
    const auto stopped = request_stop();
    if (!stopped) first = stopped.error();
    while (impl_->live_threads.load() != 0U) {
        ControlWorkerCompletion completion{};
        bool drained = false;
        for (const auto& lane : impl_->lanes) {
            if (lane != nullptr) {
                while (lane->try_pop(completion)) drained = true;
            }
        }
        if (!drained) {
            pollfd descriptor{impl_->wake.read_fd(), POLLIN, 0};
            (void)::poll(&descriptor, 1U, 10);
            impl_->wake.drain();
        }
    }
    ControlWorkerCompletion completion{};
    for (const auto& lane : impl_->lanes) {
        if (lane != nullptr) {
            while (lane->try_pop(completion)) {}
        }
    }
    const auto joined = join();
    if (!joined && first == Error::OK) first = joined.error();
    return first == Error::OK ? Result<void>::success() : Result<void>::failure(first);
}

Result<void> ControlWorkerLanes::join() noexcept
{
    if (!impl_ || impl_->joined) return Result<void>::success();
    Error first = impl_->worker_error.load();
    for (auto& lane : impl_->lanes) {
        if (lane == nullptr || !lane->started || lane->joined) continue;
        if (pthread_join(lane->thread, nullptr) != 0 && first == Error::OK) {
            first = Error::INTERNAL;
        }
        lane->joined = true;
    }
    impl_->joined = true;
    return first == Error::OK ? Result<void>::success() : Result<void>::failure(first);
}

}  // namespace px4::userland::ipc::posix
