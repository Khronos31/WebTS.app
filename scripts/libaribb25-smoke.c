/* Build-only B25 core boundary; no card, key, or TS payload enters this ABI. */
#include "multi2.h"
#include "multi2_error_code.h"
#include "ts_section_parser.h"
#include "ts_section_parser_error_code.h"

#include <stdint.h>

enum {
    WEBTS_B25_SMOKE_OK = 0,
    WEBTS_B25_SMOKE_FACTORY_FAILED = 1,
    WEBTS_B25_SMOKE_MULTI2_CONTRACT = 2,
    WEBTS_B25_SMOKE_PARSER_CONTRACT = 3,
};

/*
 * Exercise only deterministic no-card/no-input contracts from the vendored
 * MULTI2 and TS section parser cores. A nonzero fixed code is returned for a
 * contract mismatch; no raw error, key, card response, or payload is exposed.
 */
int32_t webts_b25_core_no_card_smoke(void)
{
    MULTI2 *multi2 = create_multi2();
    TS_SECTION_PARSER *parser = create_ts_section_parser();
    if (multi2 == 0 || parser == 0) {
        if (multi2 != 0) multi2->release(multi2);
        if (parser != 0) parser->release(parser);
        return WEBTS_B25_SMOKE_FACTORY_FAILED;
    }

    const int multi2_result = multi2->decrypt(multi2, 0, 0, 0);
    multi2->release(multi2);
    if (multi2_result != MULTI2_ERROR_INVALID_PARAMETER) {
        parser->release(parser);
        return WEBTS_B25_SMOKE_MULTI2_CONTRACT;
    }

    TS_SECTION section;
    const int parser_result = parser->get(parser, &section);
    parser->release(parser);
    if (parser_result != TS_SECTION_PARSER_ERROR_NO_SECTION_DATA) {
        return WEBTS_B25_SMOKE_PARSER_CONTRACT;
    }
    return WEBTS_B25_SMOKE_OK;
}
