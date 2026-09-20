/*
 * Source-backed B25 facade smoke.  It creates/configures/releases the
 * upstream ARIB_STD_B25 object without a B-CAS card or TS input.  It never
 * calls put/get, card methods, or a descrambling path.
 */
#include "arib_std_b25.h"
#include "arib_std_b25_error_code.h"

#include <stdint.h>

enum {
    WEBTS_B25_FACADE_OK = 0,
    WEBTS_B25_FACADE_FACTORY_FAILED = 1,
    WEBTS_B25_FACADE_CONFIG_FAILED = 2,
    WEBTS_B25_FACADE_STATE_FAILED = 3,
};

int32_t webts_b25_facade_no_card_smoke(void)
{
    ARIB_STD_B25 *facade = create_arib_std_b25();
    int result;

    if (facade == 0 || facade->release == 0)
        return WEBTS_B25_FACADE_FACTORY_FAILED;
    if (facade->set_emm_proc == 0 || facade->set_unit_size == 0 ||
        facade->get_program_count == 0) {
        facade->release(facade);
        return WEBTS_B25_FACADE_FACTORY_FAILED;
    }

    /* Keep EMM processing disabled until a card-backed path is reviewed. */
    result = facade->set_emm_proc(facade, 0);
    if (result != 0) {
        facade->release(facade);
        return WEBTS_B25_FACADE_CONFIG_FAILED;
    }
    result = facade->set_unit_size(facade, 188);
    if (result != 0) {
        facade->release(facade);
        return WEBTS_B25_FACADE_CONFIG_FAILED;
    }
    if (facade->get_program_count(facade) != 0) {
        facade->release(facade);
        return WEBTS_B25_FACADE_STATE_FAILED;
    }

    facade->release(facade);
    return WEBTS_B25_FACADE_OK;
}
