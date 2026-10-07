/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { getCustomColorString } from "@equicordplugins/customUserColors";
import { hash as h64 } from "@intrnl/xxhash64";
import definePlugin, { OptionType } from "@utils/types";
import { GuildMemberStore, UserStore } from "@webpack/common";

type ColorStrings = Record<"primaryColor" | "secondaryColor" | "tertiaryColor", string>;

interface MessageColorProps {
    colorString?: string;
    colorStrings?: ColorStrings;
}

interface DisplayNameStyles {
    colors: number[];
    effectId: number;
    fontId: number;
    ircColorsOriginalColors?: number[];
}

const settings = definePluginSettings({
    lightness: {
        description: "Lightness, in %. Change if the colors are too light or too dark (this does not affect colored Nitro names).",
        type: OptionType.NUMBER,
        default: 70,
    },
    memberListColors: {
        description: "Color otherwise-uncolored names in the member list",
        restartNeeded: true,
        type: OptionType.BOOLEAN,
        default: true
    },
    applyColorOnlyInDms: {
        displayName: "Apply Color Only In DMs",
        description: "Apply colors only in direct messages; do not apply colors in servers.",
        restartNeeded: false,
        type: OptionType.BOOLEAN,
        default: false
    },
    applyToNitroUsersWithColoredNames: {
        displayName: "Apply to Nitro Users with Colored Names",
        description: "Apply colors to users with Nitro that have styled & colored names.",
        restartNeeded: true,
        type: OptionType.BOOLEAN,
        default: true
    }
});

function calculateNameColorForUser(id?: string) {
    const idHash = id ? h64(id) : null;

    return idHash && `hsl(${idHash % 360n}, 100%, ${settings.store.lightness}%)`;
}

function getCustomColor(userId?: string) {
    if (Settings.plugins.CustomUserColors.enabled) {
        return getCustomColorString(userId, true);
    }
}

function hasDisplayNameStyles(userId?: string, guildId?: string, user?: any) {
    if (!userId) return false;

    // A server profile's style takes precedence over the user's global style.
    // These styles are resolved separately from role colorString/colorStrings,
    // so those render props can be empty even while a Nitro style is active.
    if (guildId && GuildMemberStore.getMember(guildId, userId)?.displayNameStyles) return true;

    return Boolean(user?.displayNameStyles ?? UserStore.getUser(userId)?.displayNameStyles);
}

export default definePlugin({
    name: "IRCColorsNitro",
    description: "Adds IRC colors to names while keeping Nitro name styles and effects always active.",
    tags: ["Appearance", "Customisation"],
    authors: [{ name: "Local user plugin", id: 0n }],
    settings,

    patches: [
        {
            find: '="SYSTEM_TAG"',
            replacement: {
                match: /(?<=colorString:\i,colorStrings:\i,colorRoleName:\i.*?}=)(\i),/,
                replace: "$self.wrapMessageColorProps($1,arguments[0]),"
            }
        },
        {
            find: "#{intl::GUILD_OWNER}),children:",
            replacement: [
                {
                    // Preserve Discord's final role/Nitro solid color. Generate a color
                    // only when that final value is nullish.
                    match: /colorString:(\i)\?\?null(?=,name:)/g,
                    replace: "colorString:$self.getMemberListColor($1,arguments[0])"
                },
                {
                    match: /animateRoleGradient:\i/,
                    replace: "animateRoleGradient:true"
                }
            ],
            predicate: () => settings.store.memberListColors
        },
        {
            find: 'location:"useDisplayNameStyles"',
            replacement: {
                match: /(?<=;return )(\i\|\|\i\?void 0!==\i\?.{0,100}?:null)(?=})/,
                replace: "$self.getIrcDisplayNameStyles($1,arguments[0])"
            },
            predicate: () => settings.store.applyToNitroUsersWithColoredNames
        },
        {
            find: "data-username-with-effects",
            replacement: [
                {
                    match: /(?<=inProfile:(\i)=!1.{0,250}?\i=\(0,\i\.\i\)\()\i(?=,\i\),\i=\(0,\i\.\i\)\(\{displayNameStyles:)/,
                    replace: "$self.restoreProfileNitroColors($&,$1)"
                },
                {
                    match: /(\i)=\i!==\i\.G\.PLAIN,(\i)=\i===\i\.G\.ANIMATED&&!(\i)/,
                    replace: "$1=!0,$2=!$3"
                }
            ]
        }
    ],

    getIrcDisplayNameStyles(displayNameStyles: DisplayNameStyles | null | undefined, context?: { userId?: string; guildId?: string; }) {
        if (!displayNameStyles) return displayNameStyles;

        const userId = context?.userId ?? UserStore.getCurrentUser()?.id;
        if (!userId) return displayNameStyles;
        if (settings.store.applyColorOnlyInDms && context?.guildId !== undefined) return displayNameStyles;

        const customColor = getCustomColor(userId);
        if (customColor) {
            const parsed = /^#([0-9a-f]{6})$/i.exec(customColor);
            if (parsed) {
                return {
                    ...displayNameStyles,
                    colors: [Number.parseInt(parsed[1], 16)],
                    ircColorsOriginalColors: displayNameStyles.ircColorsOriginalColors ?? displayNameStyles.colors
                };
            }
        }

        const color = calculateNameColorForUser(userId);
        if (!color) return displayNameStyles;

        const hue = Number(h64(userId) % 360n);
        const colors = displayNameStyles.colors.map((_, index, source) => {
            const offset = source.length > 1 ? 14 * (index / (source.length - 1) - 0.5) : 0;
            const lightness = Math.max(20, Math.min(85, settings.store.lightness + offset));
            return this.hslToInt(hue, lightness);
        });

        return {
            ...displayNameStyles,
            colors,
            ircColorsOriginalColors: displayNameStyles.ircColorsOriginalColors ?? displayNameStyles.colors
        };
    },

    restoreProfileNitroColors(displayNameStyles: DisplayNameStyles | null | undefined, inProfile?: boolean) {
        if (!inProfile || !displayNameStyles?.ircColorsOriginalColors) return displayNameStyles;

        return {
            ...displayNameStyles,
            colors: displayNameStyles.ircColorsOriginalColors
        };
    },

    hslToInt(hue: number, lightness: number) {
        const normalizedLightness = lightness / 100;
        const chroma = 1 - Math.abs(2 * normalizedLightness - 1);
        const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
        const offset = normalizedLightness - chroma / 2;
        let red = 0;
        let green = 0;
        let blue = 0;

        if (hue < 60) [red, green] = [chroma, x];
        else if (hue < 120) [red, green] = [x, chroma];
        else if (hue < 180) [green, blue] = [chroma, x];
        else if (hue < 240) [green, blue] = [x, chroma];
        else if (hue < 300) [red, blue] = [x, chroma];
        else [red, blue] = [chroma, x];

        return (Math.round((red + offset) * 255) << 16)
            | (Math.round((green + offset) * 255) << 8)
            | Math.round((blue + offset) * 255);
    },

    wrapMessageColorProps(colorProps: MessageColorProps, context: any) {
        try {
            // Discord has already resolved role colors and Nitro solid/gradient
            // styles here. Never replace either representation.
            if (colorProps.colorString || colorProps.colorStrings) return colorProps;

            const colorString = this.calculateMessageFallback(context);
            return colorString ? { ...colorProps, colorString } : colorProps;
        } catch (error) {
            console.error("IRCColorsNitro: failed to calculate message color", error);
            return colorProps;
        }
    },

    calculateMessageFallback(context: any) {
        const userId: string | undefined = context?.message?.author?.id;
        const guildId: string | undefined = context?.channel?.guild_id;
        const existingColor: string | undefined = context?.author?.colorString;

        // This secondary check protects role colors if Discord changes where the
        // final render color is assembled.
        if (existingColor) return existingColor;
        if (hasDisplayNameStyles(userId, guildId, context?.message?.author)) return;

        const customColor = getCustomColor(userId);
        if (customColor) return customColor;

        if (context?.message?.channel_id === "1337" && userId === "313337") return;
        if (settings.store.applyColorOnlyInDms && !context?.channel?.isPrivate?.()) return;

        const color = calculateNameColorForUser(userId);

        // Guarantee a minimum hue difference in DMs.
        if (context?.channel?.isPrivate?.() && color && userId) {
            const currentUserId = UserStore.getCurrentUser()?.id;
            if (currentUserId && userId !== currentUserId) {
                const currentUserColor = Number(h64(currentUserId) % 360n);
                const otherUserColor = Number(h64(userId) % 360n);
                const difference = Math.min(
                    Math.abs(currentUserColor - otherUserColor),
                    360 - Math.abs(currentUserColor - otherUserColor)
                );

                if (difference < 70) {
                    return `hsl(${(otherUserColor + 180) % 360}, 100%, ${settings.store.lightness}%)`;
                }
            }
        }

        return color;
    },

    getMemberListColor(discordColor: string | undefined, context: any) {
        try {
            // This is Discord's already-computed role or Nitro solid color.
            if (discordColor) return discordColor;

            const userId: string | undefined = context?.user?.id;
            const existingColor: string | undefined = context?.colorString;
            if (existingColor) return existingColor;
            if (hasDisplayNameStyles(userId, context?.guildId, context?.user)) return;

            const customColor = getCustomColor(userId);
            if (customColor) return customColor;

            if (settings.store.applyColorOnlyInDms && context?.guildId !== undefined) return;
            return calculateNameColorForUser(userId);
        } catch (error) {
            console.error("IRCColorsNitro: failed to calculate member-list color", error);
            return discordColor;
        }
    }
});
