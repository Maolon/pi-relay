"""Wire interoperability fixture; uses only the Python standard library."""
import json, os, socket, stat, sys, uuid

def private(path):
    st = os.lstat(path)
    assert stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_mode & 0o077 == 0
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as file:
        current = os.fstat(file.fileno())
        assert (st.st_ino, st.st_dev) == (current.st_ino, current.st_dev)
        return json.load(file)

handle = private(sys.argv[1]); discovery = private(handle['discoveryFile'])
assert discovery['identity'] == handle['targetFingerprint'] and discovery['realm'] == handle['realm']
with socket.socket(socket.AF_UNIX) as connection:
    connection.settimeout(3); connection.connect(discovery['endpoint'])
    stream = connection.makefile('rwb')
    def call(op, **fields):
        request = dict(protocol='pi-relay', major=1, minor=1, requestId=uuid.uuid4().hex, op=op, **fields)
        stream.write(json.dumps(request, allow_nan=False).encode('utf8') + b'\n'); stream.flush()
        response = json.loads(stream.readline(131073)); assert response['requestId'] == request['requestId'] and response['ok']
        return response['result']
    hello = call('connect', bindingId=handle['bindingId'], credential=handle['credential'], requiredFeatures=['receipt-query'])
    assert hello['targetFingerprint'] == handle['targetFingerprint'] and hello['bindingId'] == handle['bindingId']
    result = call('receipt', bindingId=handle['bindingId'], bindingRevision=hello['bindingRevision'], attachmentId=hello['attachmentId'], eventId=sys.argv[2])
    print(json.dumps(result))
