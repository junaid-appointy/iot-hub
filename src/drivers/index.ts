import { Driver } from '../core/types';
import { hue } from './hue';
import { kasa } from './kasa';
import { lifx } from './lifx';
import { nanoleaf } from './nanoleaf';
import { shelly } from './shelly';
import { tuya } from './tuya';
import { wiz } from './wiz';
import { wled } from './wled';
import { yeelight } from './yeelight';

/** Built-in drivers. To support a new brand, implement `Driver` and add it here. */
export const builtInDrivers: Driver[] = [wiz, hue, kasa, yeelight, lifx, tuya, shelly, wled, nanoleaf];
