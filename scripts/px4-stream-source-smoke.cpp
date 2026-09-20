/*
 * Build-only retention check for the upstream Q3U4 stream data-plane API.
 * It deliberately does not construct the threaded data plane or invoke
 * MockTransport: stop/join ordering requires a worker-only bounded harness.
 */
#include "px4/q3u4_stream.h"

#include <cstddef>
#include <cstdint>
#include <memory>

using px4::userland::Q3U4StreamDataPlane;
using px4::userland::Result;
using px4::userland::StreamCounters;
using px4::userland::StreamReadResult;
using px4::userland::StreamTerminal;
using px4::userland::Transport;
using px4::userland::TunerAttachment;
using px4::userland::TunerStreamFinalSnapshot;

extern "C" std::uint32_t webts_px4_stream_source_link_smoke() noexcept
{
    using create_fn = Result<std::unique_ptr<Q3U4StreamDataPlane>> (*)(
        Transport&, Transport&, std::size_t);
    using attach_fn = Result<void> (Q3U4StreamDataPlane::*)(const TunerAttachment&) noexcept;
    using read_fn = Result<StreamReadResult> (Q3U4StreamDataPlane::*)(
        const TunerAttachment&, px4::userland::MutableByteView, px4::userland::Timeout) noexcept;
    using stats_fn = Result<StreamCounters> (Q3U4StreamDataPlane::*)(
        const TunerAttachment&) const noexcept;
    using final_fn = Result<TunerStreamFinalSnapshot> (Q3U4StreamDataPlane::*)(
        const TunerAttachment&) const noexcept;
    using terminal_fn = Result<StreamTerminal> (Q3U4StreamDataPlane::*)(
        const TunerAttachment&) const noexcept;
    using shutdown_fn = Result<void> (Q3U4StreamDataPlane::*)() noexcept;

    volatile create_fn create_entry = &Q3U4StreamDataPlane::create;
    volatile attach_fn attach_entry = &Q3U4StreamDataPlane::attach;
    volatile read_fn read_entry = &Q3U4StreamDataPlane::read;
    volatile stats_fn stats_entry = &Q3U4StreamDataPlane::stats;
    volatile final_fn final_entry = &Q3U4StreamDataPlane::final_snapshot;
    volatile terminal_fn terminal_entry = &Q3U4StreamDataPlane::terminal;
    volatile shutdown_fn shutdown_entry = &Q3U4StreamDataPlane::shutdown;
    return (create_entry != nullptr && attach_entry != nullptr && read_entry != nullptr &&
            stats_entry != nullptr && final_entry != nullptr && terminal_entry != nullptr &&
            shutdown_entry != nullptr) ? 0U : 255U;
}
