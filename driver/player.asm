; The ROM gbscore plays songs on: hUGEDriver at the game's tick rate, with the song written in at $1000. The ROM has
; no banks (rgblink -t), so the song gets the 28 KB from there to $7FFF.
; It starts the way a CrossZGB game does: Color only, double speed, CrossZGB's sound and timer setup (Music.h,
; Sound.h), so the timer ticks at 2 × 4096 / (256 − $78) = 60.24 Hz.

include "include/hardware.inc"

DEF SONG EQU $1000
DEF TIMER_MODULO EQU $78

SECTION "Timer interrupt", ROM0[$0050]
    jp timer_isr

SECTION "Entry", ROM0[$0100]
    di
    jp start
    ds $0150 - @, 0 ; the header, which rgbfix fills in

SECTION "Player", ROM0
start:
    ld sp, $E000

    ; The screen isn't used, and with it off the emulator doesn't draw frames. Turn it off in vertical blank.
.wait_vblank:
    ldh a, [rLY]
    cp 144
    jr c, .wait_vblank
    xor a
    ldh [rLCDC], a

    ; Double speed.
    xor a
    ldh [rIE], a
    ld a, P1F_GET_NONE
    ldh [rP1], a
    ld a, KEY1F_PREPARE
    ldh [rKEY1], a
    stop

    ; Sound on, then CrossZGB's sfx_sound_init and sfx_sound_cut.
    ld a, AUDENA_ON
    ldh [rNR52], a
    ld a, $FF
    ldh [rNR51], a
    ld a, $77
    ldh [rNR50], a
    xor a
    ldh [rNR12], a
    ldh [rNR22], a
    ldh [rNR32], a
    ldh [rNR42], a
    ld a, $C0
    ldh [rNR14], a
    ldh [rNR24], a
    ldh [rNR44], a

    ld hl, SONG
    call hUGE_init

    xor a
    ld [wTicks], a
    ld a, TIMER_MODULO
    ldh [rTMA], a
    ldh [rTIMA], a
    ld a, TACF_START | TACF_4KHZ
    ldh [rTAC], a
    xor a
    ldh [rIF], a
    ld a, IEF_TIMER
    ldh [rIE], a
    ei
.wait:
    halt
    nop
    jr .wait

timer_isr:
    push af
    push bc
    push de
    push hl
    call hUGE_dosound
    ld hl, wTicks
    inc [hl]
    pop hl
    pop de
    pop bc
    pop af
    reti

SECTION "Player variables", WRAM0
; Counts calls to hUGE_dosound, so the host can step one tick at a time and read the driver's position.
wTicks:: db

; Room for the song, so the link fails if the code ever grows into it. The host writes the song over it.
SECTION "Song", ROM0[SONG]
    ds $8000 - SONG, 0
