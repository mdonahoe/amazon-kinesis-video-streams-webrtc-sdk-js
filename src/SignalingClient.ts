import { EventEmitter } from 'events';

import { Role } from './Role';
import { SigV4RequestSigner } from './internal/SigV4RequestSigner';
import { validateValueNil, validateValueNonNil } from './internal/utils';

export type QueryParams = { [queryParam: string]: string };

export interface RequestSigner {
    getSignedURL: (signalingEndpoint: string, queryParams: QueryParams) => Promise<string>;
}

export interface Credentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}

export interface SignalingClientConfig {
    channelARN: string;
    channelEndpoint: string;
    credentials?: Credentials;
    region: string;
    requestSigner?: RequestSigner;
    role: Role;
    clientId?: string;
}

enum MessageType {
    SDP_ANSWER = 'SDP_ANSWER',
    SDP_OFFER = 'SDP_OFFER',
    ICE_CANDIDATE = 'ICE_CANDIDATE',
}

interface WebSocketMessage {
    messageType: MessageType;
    messagePayload: string;
    senderClientId?: string;
}

/**
 * Client for sending and receiving messages from a KVS Signaling Channel. The client can operate as either the 'MASTER' or a 'VIEWER'.
 *
 * Typically, the 'MASTER' listens for ICE candidates and SDP offers and responds with and SDP answer and its own ICE candidates.
 *
 * Typically, the 'VIEWER' sends an SDP offer and its ICE candidates and then listens for ICE candidates and SDP answers from the 'MASTER'.
 */
export class SignalingClient extends EventEmitter {
    private static DEFAULT_CLIENT_ID = 'MASTER';

    private websocket: WebSocket = null;
    private creatingWebSocket = false;
    private readonly requestSigner: RequestSigner;
    private readonly config: SignalingClientConfig;
    private readonly pendingIceCandidatesByClientId: { [clientId: string]: object[] } = {};
    private readonly hasReceivedRemoteSDPByClientId: { [clientId: string]: boolean } = {};

    /**
     * Creates a new SignalingClient. The connection with the signaling service must be opened with the 'open' method.
     * @param {SignalingClientConfig} config - Configuration options and parameters.
     * is not provided, it will be loaded from the global scope.
     */
    public constructor(config: SignalingClientConfig) {
        super();

        // Validate config
        validateValueNonNil(config, 'SignalingClientConfig');
        validateValueNonNil(config.role, 'role');
        if (config.role === Role.VIEWER) {
            validateValueNonNil(config.clientId, 'clientId');
        } else {
            validateValueNil(config.clientId, 'clientId');
        }
        validateValueNonNil(config.channelARN, 'channelARN');
        validateValueNonNil(config.region, 'region');
        validateValueNonNil(config.channelEndpoint, 'channelEndpoint');

        this.config = { ...config }; // Copy config to new object for immutability.

        if (config.requestSigner) {
            this.requestSigner = config.requestSigner;
        } else {
            validateValueNonNil(config.credentials, 'credentials');
            validateValueNonNil(config.credentials.accessKeyId, 'credentials.accessKeyId');
            validateValueNonNil(config.credentials.secretAccessKey, 'credentials.secretAccessKey');
            this.config.credentials = { ...config.credentials }; // Copy credentials to new object for immutability.
            this.requestSigner = new SigV4RequestSigner(config.region, config.credentials);
        }

        // Bind event handlers
        this.onOpen = this.onOpen.bind(this);
        this.onMessage = this.onMessage.bind(this);
        this.onError = this.onError.bind(this);
        this.onClose = this.onClose.bind(this);
    }

    /**
     * Opens the connection with the signaling service. Listen to the 'open' event to be notified when the connection has been opened.
     */
    public open(): void {
        if (this.websocket !== null || this.creatingWebSocket) {
            throw new Error('Client is already open or opening');
        }
        this.creatingWebSocket = true;

        // The process of opening the connection is asynchronous via promises, but the interaction model is to handle asynchronous actions via events.
        // Therefore, we just kick off the asynchronous process and then return and let it fire events.
        this.asyncOpen()
            .then()
            .catch(err => this.onError(err))
            .then(() => (this.creatingWebSocket = false));
    }

    /**
     * Asynchronous implementation of `open`.
     */
    private async asyncOpen(): Promise<void> {
        const queryParams: QueryParams = {
            'X-Amz-ChannelARN': this.config.channelARN,
        };
        if (this.config.role === Role.VIEWER) {
            queryParams['X-Amz-ClientId'] = this.config.clientId;
        }
        const signedURL = await this.requestSigner.getSignedURL(this.config.channelEndpoint, queryParams);
        this.websocket = new WebSocket(signedURL);

        this.websocket.addEventListener('open', this.onOpen);
        this.websocket.addEventListener('message', this.onMessage);
        this.websocket.addEventListener('error', this.onError);
        this.websocket.addEventListener('close', this.onClose);
    }

    /**
     * Closes the connection to the KVS Signaling Service. If already closed or closing, no action is taken. Listen to the 'close' event to be notified when the
     * connection has been closed.
     */
    public close(): void {
        if (this.websocket === null) {
            return;
        }
        if (this.websocket.readyState !== WebSocket.CLOSING && this.websocket.readyState !== WebSocket.CLOSED) {
            this.websocket.close();
        }
    }

    /**
     * Sends the given SDP offer to the signaling service.
     *
     * Typically, only the 'VIEWER' role should send an SDP offer.
     * @param {RTCSessionDescription} sdpOffer - SDP offer to send.
     * @param {string} [recipientClientId] - ID of the client to send the message to. Required for 'MASTER' role. Should not be present for 'VIEWER' role.
     */
    public sendSdpOffer(sdpOffer: RTCSessionDescription, recipientClientId?: string): void {
        this.sendMessage(MessageType.SDP_OFFER, sdpOffer.toJSON(), recipientClientId);
    }

    /**
     * Sends the given SDP answer to the signaling service.
     *
     * Typically, only the 'MASTER' role should send an SDP answer.
     * @param {RTCSessionDescription} sdpAnswer - SDP answer to send.
     * @param {string} [recipientClientId] - ID of the client to send the message to. Required for 'MASTER' role. Should not be present for 'VIEWER' role.
     */
    public sendSdpAnswer(sdpAnswer: RTCSessionDescription, recipientClientId?: string): void {
        this.sendMessage(MessageType.SDP_ANSWER, sdpAnswer.toJSON(), recipientClientId);
    }

    /**
     * Sends the given ICE candidate to the signaling service.
     *
     * Typically, both the 'VIEWER' role and 'MASTER' role should send ICE candidates.
     * @param {RTCIceCandidate} iceCandidate - ICE candidate to send.
     * @param {string} [recipientClientId] - ID of the client to send the message to. Required for 'MASTER' role. Should not be present for 'VIEWER' role.
     */
    public sendIceCandidate(iceCandidate: RTCIceCandidate, recipientClientId?: string): void {
        this.sendMessage(MessageType.ICE_CANDIDATE, iceCandidate.toJSON(), recipientClientId);
    }

    /**
     * Validates the WebSocket connection is open and that the recipient client id is present if sending as the 'MASTER'. Encodes the given message payload
     * and sends the message to the signaling service.
     */
    private sendMessage(action: MessageType, messagePayload: object, recipientClientId?: string): void {
        if (this.websocket === null || this.websocket.readyState !== WebSocket.OPEN) {
            throw new Error('Could not send message because the connection to the signaling service is not open.');
        }
        this.validateRecipientClientId(recipientClientId);

        this.websocket.send(
            JSON.stringify({
                action,
                messagePayload: SignalingClient.serializeJSONObjectAsBase64String(messagePayload),
                recipientClientId: recipientClientId || undefined,
            }),
        );
    }

    /**
     * Removes all event listeners from the WebSocket and removes the reference to the WebSocket object.
     */
    private cleanupWebSocket(): void {
        if (this.websocket === null) {
            return;
        }
        this.websocket.removeEventListener('open', this.onOpen);
        this.websocket.removeEventListener('message', this.onMessage);
        this.websocket.removeEventListener('error', this.onError);
        this.websocket.removeEventListener('close', this.onClose);
        this.websocket = null;
    }

    /**
     * WebSocket 'open' event handler. Forwards the event on to listeners.
     */
    private onOpen(): void {
        this.emit('open');
    }

    /**
     * WebSocket 'message' event handler. Attempts to parse the message and handle it according to the message type.
     */
    private onMessage(event: MessageEvent): void {
        try {
            const { messageType, messagePayload, senderClientId } = JSON.parse(event.data) as WebSocketMessage;
            switch (messageType) {
                case MessageType.SDP_OFFER:
                    this.emit('sdpOffer', SignalingClient.parseJSONObjectFromBase64String(messagePayload), senderClientId);
                    this.emitPendingIceCandidates(senderClientId);
                    return;
                case MessageType.SDP_ANSWER:
                    this.emit('sdpAnswer', SignalingClient.parseJSONObjectFromBase64String(messagePayload), senderClientId);
                    this.emitPendingIceCandidates(senderClientId);
                    return;
                case MessageType.ICE_CANDIDATE:
                    this.emitOrQueueIceCandidate(SignalingClient.parseJSONObjectFromBase64String(messagePayload), senderClientId);
                    return;
            }
        } catch (e) {
            console.error(e); // TODO: Improve error handling
        }
    }

    /**
     * Takes the given base64 encoded string and decodes it into a JSON object.
     */
    private static parseJSONObjectFromBase64String(base64EncodedString: string): object {
        return JSON.parse(atob(base64EncodedString));
    }

    /**
     * Takes the given JSON object and encodes it into a base64 string.
     */
    private static serializeJSONObjectAsBase64String(object: object): string {
        return btoa(JSON.stringify(object));
    }

    /**
     * If an SDP offer or answer has already been received from the given client, then the given ICE candidate is emitted. Otherwise, it is queued up for when
     * an SDP offer or answer is received.
     */
    private emitOrQueueIceCandidate(iceCandidate: object, clientId?: string): void {
        const clientIdKey = !clientId ? SignalingClient.DEFAULT_CLIENT_ID : clientId;
        if (this.hasReceivedRemoteSDPByClientId[clientIdKey]) {
            this.emit('iceCandidate', iceCandidate, clientId);
        } else {
            if (!this.pendingIceCandidatesByClientId[clientIdKey]) {
                this.pendingIceCandidatesByClientId[clientIdKey] = [];
            }
            this.pendingIceCandidatesByClientId[clientIdKey].push(iceCandidate);
        }
    }

    /**
     * Emits any pending ICE candidates for the given client and records that an SDP offer or answer has been received from the client.
     */
    private emitPendingIceCandidates(clientId?: string): void {
        if (!clientId) {
            clientId = SignalingClient.DEFAULT_CLIENT_ID;
        }
        this.hasReceivedRemoteSDPByClientId[clientId] = true;
        const pendingIceCandidates = this.pendingIceCandidatesByClientId[clientId];
        if (!pendingIceCandidates) {
            return;
        }
        delete this.pendingIceCandidatesByClientId[clientId];
        pendingIceCandidates.forEach(iceCandidate => {
            this.emit('iceCandidate', iceCandidate, clientId);
        });
    }

    /**
     * Throws an error if the recipient client id is null and the current role is 'MASTER' as all messages sent as 'MASTER' should have a recipient client id.
     */
    private validateRecipientClientId(recipientClientId?: string): void {
        if (this.config.role === Role.MASTER && !recipientClientId) {
            throw new Error('Missing recipient client id. As the MASTER, all messages must be sent with a recipient client id.');
        } else if (this.config.role === Role.VIEWER && recipientClientId) {
            throw new Error('Unexpected recipient client id. As the VIEWER, messages must not be sent with a recipient client id.');
        }
    }

    /**
     * 'error' event handler. Forwards the error onto listeners.
     */
    private onError(error: Error | Event): void {
        this.emit('error', error);
    }

    /**
     * 'close' event handler. Forwards the error onto listeners and cleans up the connection.
     */
    private onClose(): void {
        this.cleanupWebSocket();
        this.emit('close');
    }
}
