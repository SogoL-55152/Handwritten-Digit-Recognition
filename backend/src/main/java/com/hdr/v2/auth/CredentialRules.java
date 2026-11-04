package com.hdr.v2.auth;

import com.hdr.v2.V2Exception;

import java.util.regex.Pattern;

/** Explicit cross-client character set; login deliberately keeps legacy validation. */
public final class CredentialRules {
    public static final String NON_WHITESPACE = "[^\\x{0009}-\\x{000D}\\x{0020}\\x{0085}\\x{00A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]+";
    private static final Pattern ALLOWED = Pattern.compile(NON_WHITESPACE);

    private CredentialRules() {}

    public static void validate(String value, int minimum, String field) {
        if (value == null || value.length() < minimum || value.length() > 32 || !ALLOWED.matcher(value).matches()) {
            throw new V2Exception(400, field + "长度或空白字符不符合要求", "VALIDATION");
        }
    }
}
