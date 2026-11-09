package com.hdr.v2;

public class V2Exception extends RuntimeException {
    private final int status;
    private final String category;
    private final int retryAfterSeconds;

    public V2Exception(int status, String message) { this(status, message, null); }
    public V2Exception(int status, String message, String category) { this(status, message, category, 0); }
    public V2Exception(int status, String message, String category, int retryAfterSeconds) {
        super(message);
        this.status = status;
        this.category = category;
        this.retryAfterSeconds = retryAfterSeconds;
    }
    public int getStatus() { return status; }
    public String getCategory() { return category; }
    public int getRetryAfterSeconds() { return retryAfterSeconds; }
}
